import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Check,
  ClipboardList,
  Lock,
  Mic,
  Pause,
  Play,
  Plus,
  Square,
  Stethoscope,
  Trash2,
  X,
} from 'lucide-react';
import { Field, Input, Textarea, Select, Button, Modal } from './ui';
import {
  NOTE_STATUS,
  NOTE_TYPES,
  VITALS_FIELDS,
  ICD10,
  calculateBmi,
  abnormalVitals,
} from '../data/encounters';
import { api, isLive } from '../services/api';

/**
 * SOAP encounter note.
 *
 * Signing locks the body. After that the only legitimate change is an addendum,
 * because an audited clinical record must show what was written and when, not
 * a silently rewritten version of it.
 */
export default function EncounterNote({
  note,
  patientRecord,
  onBack,
  onSave,
  onSign,
  onAddendum,
  onCompleteTriage,
  onDictationApproved,
  can,
  currentUser,
}) {
  const [draft, setDraft] = useState(note);
  const [errors, setErrors] = useState({});
  const [addendumText, setAddendumText] = useState('');
  const [showAddendum, setShowAddendum] = useState(false);
  const [dxQuery, setDxQuery] = useState('');
  const [dictationOpen, setDictationOpen] = useState(false);
  const [dictationText, setDictationText] = useState('');
  const [dictation, setDictation] = useState(null);
  const [dictationDraft, setDictationDraft] = useState(null);
  const [dictationStatus, setDictationStatus] = useState('Ready');
  const [dictationError, setDictationError] = useState('');
  const [allergiesReviewed, setAllergiesReviewed] = useState(Boolean(patientRecord?.allergiesRecorded));
  const [recordingState, setRecordingState] = useState('idle');
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState('');
  const [recordedAudioBlob, setRecordedAudioBlob] = useState(null);
  const [catalogueOptions, setCatalogueOptions] = useState([]);
  const [serviceEvents, setServiceEvents] = useState([]);
  const [serviceQuery, setServiceQuery] = useState('');
  const [newService, setNewService] = useState(null);
  const [newQuantity, setNewQuantity] = useState('1');
  const [newEventType, setNewEventType] = useState('performed');
  const [newBillingNote, setNewBillingNote] = useState('');
  const [serviceCaptureError, setServiceCaptureError] = useState('');
  const [serviceCaptureBusy, setServiceCaptureBusy] = useState(false);
  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const speechRecognitionRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);
  const discardRecordingRef = useRef(false);
  const dictationTextRef = useRef('');

  const locked = draft.status !== NOTE_STATUS.DRAFT;
  const canWrite = can.writeNote && !locked;
  const canCaptureServices = can.captureEncounterServices && !locked;
  const flags = useMemo(() => abnormalVitals(draft.vitals), [draft.vitals]);
  const bmi = calculateBmi(draft.vitals);

  // The billing handoff needs the real catalogue, not the demo/seed one used
  // elsewhere in this app — a service id picked from the wrong list would
  // fail server-side (or worse, silently name the wrong service).
  useEffect(() => {
    if (!can.captureEncounterServices || !draft.id) return;
    let cancelled = false;
    api.catalogue.services().then((rows) => { if (!cancelled) setCatalogueOptions(rows); }).catch(() => {});
    api.encounters.serviceEvents.list(draft.id).then((rows) => { if (!cancelled) setServiceEvents(rows); }).catch(() => {});
    return () => { cancelled = true; };
  }, [can.captureEncounterServices, draft.id]);

  const serviceMatches = useMemo(() => {
    const query = serviceQuery.trim().toLowerCase();
    if (!query) return [];
    return catalogueOptions
      .filter((s) =>
        s.display_name?.toLowerCase().includes(query) ||
        s.internal_code?.toLowerCase().includes(query) ||
        (s.aliases || []).some((a) => a.toLowerCase().includes(query)))
      .slice(0, 8);
  }, [catalogueOptions, serviceQuery]);

  const addServiceEvent = async () => {
    if (!newService) {
      setServiceCaptureError('Search for and choose a service first');
      return;
    }
    setServiceCaptureBusy(true);
    setServiceCaptureError('');
    try {
      const event = await api.encounters.serviceEvents.create(draft.id, {
        serviceId: newService.id,
        eventType: newEventType,
        quantity: Number(newQuantity) || 1,
        billingNote: newBillingNote.trim() || undefined,
      });
      setServiceEvents((prev) => [
        ...prev,
        { ...event, service_name: newService.display_name, service_code: newService.internal_code },
      ]);
      setNewService(null);
      setServiceQuery('');
      setNewQuantity('1');
      setNewBillingNote('');
    } catch (error) {
      setServiceCaptureError(error.message);
    } finally {
      setServiceCaptureBusy(false);
    }
  };

  const removeServiceEvent = async (eventId) => {
    setServiceCaptureError('');
    try {
      await api.encounters.serviceEvents.remove(draft.id, eventId);
      setServiceEvents((prev) => prev.filter((e) => e.id !== eventId));
    } catch (error) {
      setServiceCaptureError(error.message);
    }
  };

  const set = (key) => (event) => setDraft((prev) => ({ ...prev, [key]: event.target.value }));
  const setVital = (key) => (event) =>
    setDraft((prev) => ({ ...prev, vitals: { ...prev.vitals, [key]: event.target.value } }));

  const browserWindow = typeof globalThis !== 'undefined' && globalThis.window ? globalThis.window : null;
  const browserNavigator = typeof globalThis !== 'undefined' && globalThis.navigator ? globalThis.navigator : null;
  const browserMediaRecorder = typeof globalThis !== 'undefined' ? globalThis.MediaRecorder : null;
  const browserUrl = typeof globalThis !== 'undefined' ? globalThis.URL : null;
  const speechRecognitionSupported = Boolean(
    browserWindow?.SpeechRecognition || browserWindow?.webkitSpeechRecognition
  );
  const microphoneSupported = Boolean(browserNavigator?.mediaDevices?.getUserMedia && browserMediaRecorder);
  const recordingActive = recordingState === 'recording' || recordingState === 'paused';
  const recordingTime = `${String(Math.floor(recordingSeconds / 60)).padStart(2, '0')}:${String(recordingSeconds % 60).padStart(2, '0')}`;

  const stopRecordingTimer = () => {
    if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
  };

  const blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.includes(',') ? result.split(',').pop() : result);
      };
      reader.onerror = () => reject(reader.error || new Error('Could not read audio recording.'));
      reader.readAsDataURL(blob);
    });

  const startRecordingTimer = () => {
    stopRecordingTimer();
    recordingTimerRef.current = window.setInterval(() => {
      setRecordingSeconds((value) => value + 1);
    }, 1000);
  };

  const releaseRecording = () => {
    stopRecordingTimer();
    try {
      speechRecognitionRef.current?.stop?.();
    } catch {
      // Browser speech recognition may already be stopped.
    }
    speechRecognitionRef.current = null;
    mediaStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
  };

  useEffect(() => () => {
    releaseRecording();
  }, []);

  useEffect(() => () => {
    if (recordedAudioUrl) browserUrl?.revokeObjectURL?.(recordedAudioUrl);
  }, [recordedAudioUrl]);

  useEffect(() => {
    dictationTextRef.current = dictationText;
  }, [dictationText]);

  const dxMatches = dxQuery.trim()
    ? ICD10.filter(
        (item) =>
          !draft.diagnoses.some((d) => d.code === item.code) &&
          `${item.code} ${item.label}`.toLowerCase().includes(dxQuery.trim().toLowerCase())
      ).slice(0, 5)
    : [];

  const addDiagnosis = (item) => {
    setDraft((prev) => ({ ...prev, diagnoses: [...prev.diagnoses, item] }));
    setDxQuery('');
  };
  const removeDiagnosis = (code) =>
    setDraft((prev) => ({ ...prev, diagnoses: prev.diagnoses.filter((d) => d.code !== code) }));

  const save = () => {
    onSave(draft);
  };

  const completeTriage = () => {
    if (onCompleteTriage) onCompleteTriage(draft);
  };

  const sign = () => {
    // A signature asserts the note is complete — so require it to be.
    const next = {};
    if (!draft.subjective?.trim()) next.subjective = 'Subjective is required before signing';
    if (!draft.objective?.trim()) next.objective = 'Objective is required before signing';
    if (!draft.assessment?.trim()) next.assessment = 'Assessment is required before signing';
    if (!draft.plan?.trim()) next.plan = 'Plan is required before signing';
    if (draft.diagnoses.length === 0) next.diagnoses = 'At least one diagnosis code is required before signing';
    setErrors(next);
    if (Object.keys(next).length) return;
    onSign(draft);
  };

  const submitAddendum = () => {
    if (!addendumText.trim()) return;
    onAddendum(draft.id, addendumText.trim());
    setAddendumText('');
    setShowAddendum(false);
  };

  const startRecording = async () => {
    setDictationError('');
    setDictationDraft(null);
    if (!microphoneSupported) {
      setDictationStatus('Failed');
      setDictationError('This browser cannot access a microphone.');
      return;
    }

    try {
      const stream = await browserNavigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      discardRecordingRef.current = false;
      if (recordedAudioUrl) browserUrl?.revokeObjectURL?.(recordedAudioUrl);
      setRecordedAudioUrl('');
      setRecordedAudioBlob(null);
      setRecordingSeconds(0);

      const preferredMimeType = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
      ].find((type) => browserMediaRecorder.isTypeSupported?.(type));
      const recorder = preferredMimeType
        ? new browserMediaRecorder(stream, { mimeType: preferredMimeType, audioBitsPerSecond: 128000 })
        : new browserMediaRecorder(stream, { audioBitsPerSecond: 128000 });
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data?.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const shouldDiscard = discardRecordingRef.current;
        discardRecordingRef.current = false;
        const blobType = audioChunksRef.current[0]?.type || recorder.mimeType || preferredMimeType || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: blobType });
        mediaStreamRef.current?.getTracks?.().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        if (shouldDiscard) return;
        if (blob.size > 0) {
          setRecordedAudioBlob(blob);
          setRecordedAudioUrl(browserUrl?.createObjectURL?.(blob) || '');
          setDictationStatus(dictationTextRef.current.trim() ? 'Transcript ready' : 'Audio captured');
        } else {
          setDictationStatus('Failed');
          setDictationError('No audio was captured. Check the selected microphone and try again.');
        }
      };

      if (speechRecognitionSupported) {
        const Recognition = browserWindow.SpeechRecognition || browserWindow.webkitSpeechRecognition;
        const recognition = new Recognition();
        let committed = dictationText.trim() ? `${dictationText.trim()} ` : '';
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-ZW';
        recognition.onresult = (event) => {
          let interim = '';
          for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const text = event.results[index][0]?.transcript || '';
            if (event.results[index].isFinal) committed += `${text.trim()} `;
            else interim += text;
          }
          setDictationText(`${committed}${interim}`.trim());
        };
        recognition.onerror = (event) => {
          if (event.error === 'not-allowed') {
            setDictationError('Microphone permission was denied.');
          }
        };
        speechRecognitionRef.current = recognition;
        recognition.start();
      }

      recorder.start(1000);
      startRecordingTimer();
      setRecordingState('recording');
      setDictationStatus(speechRecognitionSupported ? 'Recording' : 'Recording audio');
    } catch (error) {
      releaseRecording();
      setRecordingState('idle');
      setDictationStatus('Failed');
      setDictationError(error?.name === 'NotAllowedError' ? 'Microphone permission was denied.' : 'Could not start recording.');
    }
  };

  const pauseRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === 'recording') recorder.pause();
    try {
      speechRecognitionRef.current?.stop?.();
    } catch {
      // Already stopped.
    }
    stopRecordingTimer();
    setRecordingState('paused');
    setDictationStatus('Paused');
  };

  const resumeRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === 'paused') recorder.resume();
    try {
      speechRecognitionRef.current?.start?.();
    } catch {
      // Some browsers do not allow restarting the same recognition instance.
    }
    startRecordingTimer();
    setRecordingState('recording');
    setDictationStatus(speechRecognitionSupported ? 'Recording' : 'Recording audio');
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    discardRecordingRef.current = false;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.requestData?.();
      } catch {
        // Some browsers only flush data during stop.
      }
      recorder.stop();
    } else {
      releaseRecording();
    }
    try {
      speechRecognitionRef.current?.stop?.();
    } catch {
      // Already stopped.
    }
    speechRecognitionRef.current = null;
    stopRecordingTimer();
    setRecordingState('stopped');
    setDictationStatus('Saving audio');
    if (!speechRecognitionSupported && !dictationTextRef.current.trim()) {
      setDictationError('Audio was captured. Structure will send it for transcription when server speech-to-text is configured.');
    }
  };

  const cancelRecording = () => {
    discardRecordingRef.current = true;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    releaseRecording();
    audioChunksRef.current = [];
    if (recordedAudioUrl) browserUrl?.revokeObjectURL?.(recordedAudioUrl);
    setRecordedAudioUrl('');
    setRecordedAudioBlob(null);
    setRecordingSeconds(0);
    setRecordingState('idle');
    setDictationStatus('Ready');
  };

  const closeDictation = () => {
    if (recordingActive) cancelRecording();
    setDictationOpen(false);
  };

  const localStructure = (text) => {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    const lower = oneLine.toLowerCase();
    const diagnosesMentioned = [];
    if (lower.includes('pneumonia')) diagnosesMentioned.push({ code: 'J18.9', label: 'Pneumonia, unspecified organism', sourceText: 'pneumonia' });
    if (lower.includes('hypertension')) diagnosesMentioned.push({ code: 'I10', label: 'Essential (primary) hypertension', sourceText: 'hypertension' });
    const medicationsMentioned = [];
    if (lower.includes('amoxicillin') || lower.includes('co-amoxiclav')) {
      medicationsMentioned.push({
        drug: 'Amoxicillin/clavulanate',
        strength: oneLine.match(/\b\d+\s?mg\b/i)?.[0] || '',
        route: '',
        frequency: oneLine.match(/\b(once daily|twice daily|three times daily|tds|bd|od)\b/i)?.[0] || '',
        durationDays: Number(oneLine.match(/\bfor\s+(\d+)\s+days?\b/i)?.[1] || '') || null,
        sourceText: oneLine,
      });
    }
    return {
      subjective: oneLine,
      objective: '',
      assessment: diagnosesMentioned.map((item) => item.label).join('; '),
      plan: medicationsMentioned.length ? `Medication mentioned: ${medicationsMentioned.map((item) => item.drug).join(', ')}` : '',
      followUp: '',
      diagnosesMentioned,
      medicationsMentioned,
      uncertainties: medicationsMentioned.some((item) => !item.strength || !item.frequency)
        ? [{ text: 'Medication details incomplete', reason: 'Dose or frequency was not clearly captured' }]
        : [],
    };
  };

  const generateDictationDraft = async () => {
    const transcript = dictationText.trim();
    if (transcript.length < 12 && !recordedAudioBlob) {
      setDictationError('Speak, record audio, or paste enough detail to structure the note.');
      return;
    }
    setDictationError('');
    setDictationStatus(transcript.length >= 12 ? 'Processing' : 'Transcribing audio');
    try {
      if (!isLive()) {
        setDictation({ id: `local-${Date.now()}` });
        setDictationDraft(localStructure(transcript));
        setDictationStatus('Structured draft ready');
        return;
      }
      const created = transcript.length >= 12
        ? await api.encounters.createDictation(draft.id, { transcript })
        : await api.encounters.createDictationFromAudio(draft.id, {
            audioBase64: await blobToBase64(recordedAudioBlob),
            contentType: recordedAudioBlob.type || 'audio/webm',
          });
      setDictationText(created.raw_transcript || transcript);
      setDictationStatus('Structuring');
      const structured = await api.dictations.structure(created.id);
      setDictation(structured);
      setDictationDraft(structured.structured_draft);
      setDictationStatus('Structured draft ready');
    } catch (error) {
      setDictationStatus('Failed');
      setDictationError(error.message);
    }
  };

  const mergeDictationNote = () => {
    if (!dictationDraft) return;
    setDraft((prev) => ({
      ...prev,
      subjective: dictationDraft.subjective ?? prev.subjective,
      objective: dictationDraft.objective ?? prev.objective,
      assessment: dictationDraft.assessment ?? prev.assessment,
      plan: dictationDraft.plan ?? prev.plan,
      followUp: dictationDraft.followUp ?? prev.followUp,
      diagnoses: dictationDraft.diagnosesMentioned?.length
        ? [
            ...prev.diagnoses,
            ...dictationDraft.diagnosesMentioned
              .map(({ code, label }) => ({ code, label }))
              .filter((item) => !prev.diagnoses.some((existing) => existing.code === item.code)),
          ]
        : prev.diagnoses,
    }));
  };

  const approveDictationNote = async () => {
    if (!dictationDraft) return;
    mergeDictationNote();
    if (!isLive() || !dictation?.id || String(dictation.id).startsWith('local-')) {
      setDictationStatus('Approved');
      setDictationOpen(false);
      return;
    }
    setDictationStatus('Approving');
    try {
      const result = await api.dictations.approveNote(dictation.id, {
        subjective: dictationDraft.subjective ?? '',
        objective: dictationDraft.objective ?? '',
        assessment: dictationDraft.assessment ?? '',
        plan: dictationDraft.plan ?? '',
        followUp: dictationDraft.followUp ?? '',
        diagnoses: dictationDraft.diagnosesMentioned?.map(({ code, label }) => ({ code, label })) ?? [],
      });
      if (result.encounter && onDictationApproved) {
        const mapped = onDictationApproved(result.encounter, draft);
        if (mapped) setDraft(mapped);
      }
      setDictationStatus('Approved');
      setDictationOpen(false);
    } catch (error) {
      setDictationStatus('Failed');
      setDictationError(error.message);
    }
  };

  const approveMedication = async (medication) => {
    if (!dictation?.id || !isLive()) return;
    setDictationStatus('Approving prescription');
    setDictationError('');
    try {
      await api.dictations.approvePrescription(dictation.id, { ...medication, allergiesReviewed });
      setDictationStatus('Prescription approved');
    } catch (error) {
      setDictationStatus('Failed');
      setDictationError(error.message);
    }
  };

  const statusTone =
    draft.status === NOTE_STATUS.SIGNED
      ? 'bg-success-soft text-success'
      : draft.status === NOTE_STATUS.AMENDED
        ? 'bg-brand-soft text-brand-deep'
        : 'bg-warning-wash text-warning';

  const sections = [
    { key: 'subjective', label: 'Subjective', hint: 'What the patient reports: history, symptoms, context.' },
    { key: 'objective', label: 'Objective', hint: 'Examination findings, observations, and results.' },
    { key: 'assessment', label: 'Assessment', hint: 'Clinical impression and reasoning.' },
    { key: 'plan', label: 'Plan', hint: 'Treatment, investigations, follow up, and advice given.' },
  ];

  return (
    <div className="space-y-4">
      {/* Note header */}
      <div className="rounded-lg border border-line bg-white/95 shadow-[0_16px_42px_-34px_rgba(11,21,36,0.55)]">
        <div className="flex flex-wrap items-start justify-between gap-4 p-4">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              className="mt-0.5 rounded border border-edge p-1.5 text-muted transition hover:border-brand hover:text-ink"
            >
              <ArrowLeft size={15} />
            </button>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-title text-ink">
                  {draft.type} · {draft.patientName}
                </h1>
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.08em] ${statusTone}`}>
                  {locked && <Lock size={9} />}
                  {draft.status}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted">
                {draft.patientId} · {draft.date} {draft.appointmentTime !== 'Unscheduled' && `at ${draft.appointmentTime}`} · {draft.provider}
              </p>
              {draft.createdBy && (
                <p className="mt-0.5 text-sm text-muted">
                  Created by {draft.createdBy}
                  {draft.contributors?.length > 0 && ` | Contributors: ${[...new Set(draft.contributors.map((item) => item.name).filter(Boolean))].join(', ')}`}
                </p>
              )}
              {draft.triageCompletedAt && (
                <p className="mt-0.5 text-sm text-success">
                  Triage complete{draft.triageCompletedBy ? ` by ${draft.triageCompletedBy}` : ''} | {draft.triageCompletedAt}
                </p>
              )}
              {draft.signedBy && (
                <p className="mt-0.5 text-sm text-success">Signed by {draft.signedBy} · {draft.signedAt}</p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canWrite && (
              <>
                <Button variant="secondary" type="button" onClick={save}>Save draft</Button>
                {can.prescribe && (
                  <Button variant="secondary" type="button" onClick={() => setDictationOpen(true)}>
                    <Mic size={13} /> Dictate
                  </Button>
                )}
                {draft.type?.toLowerCase().includes('triage') && !draft.triageCompletedAt && (
                  <Button variant="secondary" type="button" onClick={completeTriage}>Mark triage complete</Button>
                )}
                {can.signNote && (
                  <div className="flex flex-col items-end gap-1">
                    <Button type="button" onClick={sign}><Check size={13} /> Sign note</Button>
                    <span className="text-2xs text-muted">Signing as {currentUser}</span>
                  </div>
                )}
              </>
            )}
            {locked && can.amendNote && (
              <Button variant="secondary" type="button" onClick={() => setShowAddendum((v) => !v)}>
                <Plus size={13} /> Add addendum
              </Button>
            )}
          </div>
        </div>

        {/* Why the note is read-only, stated rather than left to be inferred. */}
        {locked && (
          <div className="flex items-center gap-2 border-t border-line bg-surface px-4 py-2.5">
            <Lock size={13} className="text-muted" />
            <p className="text-sm text-body">
              This note is signed and locked. Corrections must be recorded as an addendum so the original record stays intact.
            </p>
          </div>
        )}
        {!locked && !can.signNote && can.writeNote && (
          <div className="flex items-center gap-2 border-t border-line bg-warning-soft px-4 py-2.5">
            <AlertTriangle size={13} className="text-warning" />
            <p className="text-sm text-warning-deep">
              You can draft this note, but only a prescribing clinician can sign it.
            </p>
          </div>
        )}

        {/* Safety strip: allergies must be visible while prescribing. */}
        {patientRecord && (
          <div className={`flex flex-wrap items-center gap-x-5 gap-y-1 border-t px-4 py-2.5 text-small ${
            !patientRecord.allergiesRecorded
              ? 'border-warning-line bg-warning-soft text-warning-deep'
              : patientRecord.allergies?.length
                ? 'border-danger-line bg-danger-soft text-danger-deep'
                : 'border-line/70 bg-surface/60 text-body'
          }`}>
            <span
              role={!patientRecord.allergiesRecorded || patientRecord.allergies?.length ? 'alert' : undefined}
              className={`inline-flex items-center gap-2 ${!patientRecord.allergiesRecorded || patientRecord.allergies?.length ? 'font-semibold' : 'text-muted'}`}
            >
              {(!patientRecord.allergiesRecorded || patientRecord.allergies?.length > 0) && <AlertTriangle size={15} strokeWidth={2} className="shrink-0" aria-hidden="true" />}
              {patientRecord.allergiesRecorded
                ? patientRecord.allergies?.length
                  ? `Allergies: ${patientRecord.allergies.join('; ')}`
                  : 'Allergies: none known'
                : '⚠ Allergies not reviewed'}
            </span>
            {patientRecord.conditions?.length > 0 && (
              <span className="text-muted">Active: <strong className="font-medium text-ink">{patientRecord.conditions.join(', ')}</strong></span>
            )}
            {patientRecord.medications?.length > 0 && (
              <span className="text-muted">On: <strong className="font-medium text-ink">{patientRecord.medications.join(', ')}</strong></span>
            )}
          </div>
        )}
      </div>

      {showAddendum && (
        <div className="rounded-lg border border-edge-strong bg-surface p-4">
          <p className="mb-2 text-copy font-semibold text-brand-deep">New addendum</p>
          <Textarea
            value={addendumText}
            onChange={(e) => setAddendumText(e.target.value)}
            placeholder="Record the correction or additional information…"
          />
          <div className="mt-2.5 flex justify-end gap-2">
            <Button variant="secondary" type="button" onClick={() => setShowAddendum(false)}>Cancel</Button>
            <Button type="button" onClick={submitAddendum}>Append to note</Button>
          </div>
        </div>
      )}

      <Modal
        open={dictationOpen}
        onClose={closeDictation}
        title="Doctor dictation"
        subtitle={dictationStatus}
        width="max-w-5xl"
        footer={(
          <>
            <Button variant="secondary" type="button" onClick={closeDictation}>Close</Button>
            <Button variant="secondary" type="button" onClick={generateDictationDraft} disabled={recordingActive || dictationStatus === 'Processing'}>
              Structure
            </Button>
            <Button type="button" onClick={approveDictationNote} disabled={!dictationDraft || dictationStatus === 'Approving'}>
              Approve note fields
            </Button>
          </>
        )}
      >
        <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="space-y-3">
            <div className="rounded-lg bg-surface/60 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${recordingState === 'recording' ? 'bg-danger' : recordingState === 'paused' ? 'bg-warning' : 'bg-muted/40'}`} />
                    <p className="text-sm font-semibold text-ink">
                      {recordingState === 'recording'
                        ? 'Recording'
                        : recordingState === 'paused'
                          ? 'Paused'
                          : recordedAudioUrl
                            ? 'Audio captured'
                            : 'Ready to record'}
                    </p>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {microphoneSupported
                      ? 'The browser will ask for microphone access when recording starts.'
                      : 'This browser does not expose microphone recording to the app.'}
                  </p>
                </div>
                <div className="rounded border border-edge bg-surface px-2.5 py-1 font-mono text-sm text-ink">
                  {recordingTime}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {(recordingState === 'idle' || recordingState === 'stopped') && (
                  <Button variant="secondary" type="button" onClick={startRecording} disabled={!microphoneSupported || dictationStatus === 'Processing'}>
                    <Mic size={13} /> Start recording
                  </Button>
                )}
                {recordingState === 'recording' && (
                  <Button variant="secondary" type="button" onClick={pauseRecording}>
                    <Pause size={13} /> Pause
                  </Button>
                )}
                {recordingState === 'paused' && (
                  <Button variant="secondary" type="button" onClick={resumeRecording}>
                    <Play size={13} /> Resume
                  </Button>
                )}
                {recordingActive && (
                  <Button variant="secondary" type="button" onClick={stopRecording}>
                    <Square size={13} /> Stop
                  </Button>
                )}
                {(recordingActive || recordedAudioUrl) && (
                  <Button variant="secondary" type="button" onClick={cancelRecording}>
                    <Trash2 size={13} /> Clear
                  </Button>
                )}
              </div>

              {recordedAudioUrl && (
                <audio controls src={recordedAudioUrl} className="mt-3 w-full" />
              )}
              {!speechRecognitionSupported && microphoneSupported && (
                <p className="mt-2 text-xs text-muted">
                  Live transcript is unavailable in this browser. Audio capture is ready; OpenAI transcription will plug into this flow once credentials are configured.
                </p>
              )}
            </div>
            <Field label="Spoken transcript">
              <Textarea
                value={dictationText}
                onChange={(event) => setDictationText(event.target.value)}
                placeholder="Transcript appears here while recording on supported browsers. You can edit it before structuring."
              />
            </Field>
            {dictationError && (
              <div className="rounded border border-danger-strong bg-danger-soft p-3 text-sm text-danger">
                {dictationError}
              </div>
            )}
            <label className="flex items-center gap-2 text-sm text-body">
              <input
                type="checkbox"
                checked={allergiesReviewed}
                onChange={(event) => setAllergiesReviewed(event.target.checked)}
                className="h-4 w-4 accent-brand"
              />
              Allergies reviewed before approving medication
            </label>
          </div>

          <div className="space-y-3">
            {!dictationDraft ? (
              <div className="rounded-lg border border-dashed border-edge bg-surface p-5 text-sm text-muted">
                Structured SOAP, diagnosis, and medication suggestions appear here for review.
              </div>
            ) : (
              <>
                {[
                  ['Subjective', 'subjective'],
                  ['Objective', 'objective'],
                  ['Assessment', 'assessment'],
                  ['Plan', 'plan'],
                  ['Follow up', 'followUp'],
                ].map(([label, key]) => (
                  <Field key={key} label={label}>
                    <Textarea
                      value={dictationDraft[key] || ''}
                      onChange={(event) => setDictationDraft((prev) => ({ ...prev, [key]: event.target.value }))}
                    />
                  </Field>
                ))}
                <div className="rounded-lg bg-surface/60 p-3.5">
                  <p className="text-caption font-semibold text-muted">Diagnosis suggestions</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(dictationDraft.diagnosesMentioned || []).length === 0 ? (
                      <span className="text-sm text-muted">No coded diagnosis suggested.</span>
                    ) : dictationDraft.diagnosesMentioned.map((item) => (
                      <span key={`${item.code}-${item.label}`} className="rounded bg-brand-soft px-2 py-1 text-sm text-brand-deep">
                        {item.code} {item.label}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="rounded-lg bg-surface/60 p-3.5">
                  <p className="text-caption font-semibold text-muted">Medication suggestions</p>
                  <div className="mt-2 space-y-2">
                    {(dictationDraft.medicationsMentioned || []).length === 0 ? (
                      <p className="text-sm text-muted">No medication suggested.</p>
                    ) : dictationDraft.medicationsMentioned.map((item, index) => (
                      <div key={`${item.drug}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded border border-line bg-surface px-3 py-2">
                        <div>
                          <p className="text-sm font-semibold text-ink">{item.drug} {item.strength || ''}</p>
                          <p className="text-xs text-muted">{[item.route, item.frequency, item.durationDays ? `${item.durationDays} days` : ''].filter(Boolean).join(' | ') || 'Details incomplete'}</p>
                        </div>
                        {isLive() && (
                          <Button variant="secondary" type="button" onClick={() => approveMedication(item)}>
                            Approve Rx
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                {dictationDraft.uncertainties?.length > 0 && (
                  <div className="rounded border border-warning-line bg-warning-soft p-3">
                    <p className="text-caption font-semibold text-warning">Uncertainties</p>
                    <ul className="mt-2 space-y-1">
                      {dictationDraft.uncertainties.map((item, index) => (
                        <li key={index} className="text-sm text-warning-deep">{item.text}: {item.reason}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </Modal>

      <div className="grid gap-4 xl:grid-cols-[0.85fr_1.15fr]">
        {/* Vitals — nurse-captured, doctor-visible */}
        <div className="space-y-4">
          <section className="lh-card-pad">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-copy font-semibold text-ink">
                <Activity size={14} className="text-brand" /> Vitals
              </h2>
              {draft.vitalsRecordedBy && (
                <span className="text-xs text-muted">by {draft.vitalsRecordedBy}</span>
              )}
            </div>

            {can.recordVitals && !locked ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {VITALS_FIELDS.map((field) => (
                  <Field key={field.key} label={`${field.label} (${field.unit})`}>
                    <Input
                      value={draft.vitals?.[field.key] || ''}
                      onChange={setVital(field.key)}
                      placeholder={field.placeholder}
                    />
                  </Field>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-4">
                {VITALS_FIELDS.map((field) => (
                  <div key={field.key} className="flex items-baseline justify-between border-b border-line py-1.5">
                    <span className="text-xs text-muted">{field.label}</span>
                    <span className="text-base font-medium text-ink">
                      {draft.vitals?.[field.key] || 'Not recorded'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {bmi && (
              <p className="mt-3 text-sm text-body">
                BMI <strong className="font-semibold text-ink">{bmi}</strong>
              </p>
            )}

            {flags.length > 0 && (
              <div className="mt-3 rounded border border-warning-line bg-warning-soft p-2.5">
                <p className="mb-1 flex items-center gap-1.5 text-caption font-semibold text-warning">
                  <AlertTriangle size={11} /> Outside normal range
                </p>
                <ul className="space-y-0.5">
                  {flags.map((flag) => (
                    <li key={flag.key} className="text-sm text-warning-deep">{flag.text}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* Diagnoses */}
          <section className="lh-card-pad">
            <h2 className="mb-3 flex items-center gap-2 text-copy font-semibold text-ink">
              <Stethoscope size={14} className="text-brand" /> Diagnoses (ICD-10)
            </h2>

            <div className="mb-3 flex flex-wrap gap-1.5">
              {draft.diagnoses.length === 0 && (
                <span className="text-base text-muted">None coded yet.</span>
              )}
              {draft.diagnoses.map((dx) => (
                <span key={dx.code} className="inline-flex items-center gap-1.5 rounded bg-brand-soft px-2 py-1 text-sm text-brand-deep">
                  <strong className="font-semibold">{dx.code}</strong> {dx.label}
                  {canWrite && (
                    <button type="button" onClick={() => removeDiagnosis(dx.code)} aria-label={`Remove ${dx.code}`} className="ml-0.5 text-brand-deep hover:text-danger">
                      <X size={11} />
                    </button>
                  )}
                </span>
              ))}
            </div>

            {canWrite && (
              <div className="relative">
                <Input value={dxQuery} onChange={(e) => setDxQuery(e.target.value)} placeholder="Search ICD-10 by code or description…" />
                {dxMatches.length > 0 && (
                  <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-edge bg-white shadow-[0_12px_28px_-8px_rgba(11,21,36,0.25)]">
                    {dxMatches.map((item) => (
                      <li key={item.code}>
                        <button
                          type="button"
                          onClick={() => addDiagnosis(item)}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-surface"
                        >
                          <span className="rounded-sm bg-brand-soft px-1.5 py-0.5 text-2xs font-semibold text-brand-deep">{item.code}</span>
                          <span className="text-base text-ink">{item.label}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {errors.diagnoses && <p className="mt-1.5 text-xs text-danger">{errors.diagnoses}</p>}
          </section>

          {/* Services and billing handoff — finance-facing, kept out of the
              free-text note. Billing staff never read subjective/objective/
              assessment/plan; this is the only clinical-facing surface that
              feeds their queue. */}
          {can.captureEncounterServices && (
            <section className="lh-card-pad">
              <h2 className="mb-1 flex items-center gap-2 text-copy font-semibold text-ink">
                <ClipboardList size={14} className="text-brand" /> Services and billing handoff
              </h2>
              <p className="mb-3 text-2xs text-muted">Finance-only. Billing staff see this, never the note text.</p>

              <div className="mb-3 space-y-1.5">
                {serviceEvents.length === 0 && (
                  <p className="text-base text-muted">No services captured yet.</p>
                )}
                {serviceEvents.map((event) => (
                  <div key={event.id} className="flex items-center justify-between gap-3 rounded border border-line bg-white px-2.5 py-2">
                    <div>
                      <p className="text-sm font-medium text-ink">
                        {event.service_name} <span className="text-2xs text-muted">{event.service_code}</span>
                      </p>
                      <p className="text-xs text-muted">
                        {event.event_type === 'performed' ? 'Performed now' : event.event_type === 'ordered' ? 'Ordered' : 'Planned'}
                        {' · qty '}{event.quantity}
                        {event.billing_note ? ` · ${event.billing_note}` : ''}
                      </p>
                    </div>
                    {canCaptureServices && (
                      <button
                        type="button"
                        onClick={() => removeServiceEvent(event.id)}
                        aria-label={`Remove ${event.service_name}`}
                        className="text-muted hover:text-danger"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {canCaptureServices && (
                <div className="space-y-2 border-t border-line pt-3">
                  <div className="relative">
                    <Input
                      value={newService ? `${newService.display_name} (${newService.internal_code})` : serviceQuery}
                      onChange={(e) => { setNewService(null); setServiceQuery(e.target.value); }}
                      placeholder="Search catalogue services by name or code…"
                    />
                    {!newService && serviceMatches.length > 0 && (
                      <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-edge bg-white shadow-[0_12px_28px_-8px_rgba(11,21,36,0.25)]">
                        {serviceMatches.map((s) => (
                          <li key={s.id}>
                            <button
                              type="button"
                              onClick={() => { setNewService(s); setServiceQuery(''); }}
                              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-surface"
                            >
                              <span className="text-base text-ink">{s.display_name}</span>
                              <span className="text-2xs text-muted">{s.internal_code} · {s.category}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <Select
                      value={newEventType}
                      onChange={(e) => setNewEventType(e.target.value)}
                      options={['performed', 'ordered']}
                      render={(v) => (v === 'performed' ? 'Performed now' : 'Ordered')}
                    />
                    <Input type="number" min="1" value={newQuantity} onChange={(e) => setNewQuantity(e.target.value)} />
                    <Button type="button" onClick={addServiceEvent} disabled={serviceCaptureBusy}>
                      <Plus size={13} /> Add
                    </Button>
                  </div>
                  <Input
                    value={newBillingNote}
                    onChange={(e) => setNewBillingNote(e.target.value)}
                    placeholder="Billing-only note (optional) — visible to billing, not part of the clinical record"
                  />
                  {serviceCaptureError && <p className="text-xs text-danger">{serviceCaptureError}</p>}
                </div>
              )}
            </section>
          )}
        </div>

        {/* SOAP body */}
        <div className="space-y-4">
          <section className="lh-card-pad">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="whitespace-nowrap text-copy font-semibold text-ink">Clinical note</h2>
              {canWrite && (
                <div className="w-56">
                  <Select
                    value={draft.type}
                    onChange={set('type')}
                    options={NOTE_TYPES}
                    aria-label="Note type"
                  />
                </div>
              )}
            </div>

            <div className="space-y-4">
              {sections.map((section) => (
                <div key={section.key} className="border-t border-line/60 pt-4 first:border-0 first:pt-0">
                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <label htmlFor={`note-${section.key}`} className="text-copy font-semibold text-ink">
                      {section.label}
                      {canWrite && <span className="ml-1 text-danger">*</span>}
                    </label>
                    <span className="text-right text-caption text-muted">{section.hint}</span>
                  </div>
                  {canWrite ? (
                    <>
                      <Textarea
                        id={`note-${section.key}`}
                        value={draft[section.key] || ''}
                        onChange={set(section.key)}
                        placeholder={`${section.label}…`}
                      />
                      {errors[section.key] && <p className="mt-1.5 text-caption font-medium text-danger">{errors[section.key]}</p>}
                    </>
                  ) : (
                    <p className="whitespace-pre-wrap rounded-lg bg-surface/70 p-3.5 text-copy leading-6 text-ink">
                      {draft[section.key] || <span className="italic text-muted">Not documented</span>}
                    </p>
                  )}
                </div>
              ))}

              <div className="border-t border-line/60 pt-4">
                <label htmlFor="note-followup" className="mb-2 block text-copy font-semibold text-ink">Follow up</label>
                {canWrite ? (
                  <Input id="note-followup" value={draft.followUp || ''} onChange={set('followUp')} placeholder="e.g. Review in 8 weeks" />
                ) : (
                  <p className="rounded-lg bg-surface/70 p-3.5 text-copy text-ink">
                    {draft.followUp || <span className="italic text-muted">None specified</span>}
                  </p>
                )}
              </div>
            </div>
          </section>

          {draft.addenda?.length > 0 && (
            <section className="lh-card-pad">
              <h2 className="mb-3 text-copy font-semibold text-ink">
                Addenda ({draft.addenda.length})
              </h2>
              <div className="space-y-3">
                {draft.addenda.map((item, index) => (
                  <div key={index} className="rounded border-l-[3px] border-brand bg-surface p-3">
                    <p className="text-base leading-6 text-ink-soft">{item.text}</p>
                    <p className="mt-1.5 text-xs text-muted">{item.by} · {item.at}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

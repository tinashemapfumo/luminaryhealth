import React from 'react';

const fallbackPractice = {
  name: 'Luminary Health',
  addressLine: 'Practice address not recorded',
  city: '',
  phone: '',
  email: '',
};

const field = (value, fallback = 'Not recorded') => {
  if (value === null || value === undefined || value === '') return fallback;
  return value;
};

const listField = (items, fallback = 'Not recorded') => {
  if (!Array.isArray(items) || items.length === 0) return fallback;
  return items.filter(Boolean).join('; ') || fallback;
};

const ageFromDob = (dob) => {
  if (!dob) return '';
  const date = new Date(dob);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const years = today.getFullYear() - date.getFullYear()
    - (today < new Date(today.getFullYear(), date.getMonth(), date.getDate()) ? 1 : 0);
  return years >= 0 ? `${years} years` : '';
};

function PracticeHeader({ practice = fallbackPractice }) {
  const details = [
    practice.addressLine,
    practice.city,
    [practice.phone, practice.email].filter(Boolean).join(' | '),
  ].filter(Boolean);

  return (
    <header className="lh-prescription-print-head">
      <div>
        <p className="lh-prescription-print-brand">{practice.name || fallbackPractice.name}</p>
        {details.map((detail) => (
          <p key={detail} className="lh-prescription-print-meta">{detail}</p>
        ))}
      </div>
      <div className="lh-prescription-print-stamp">
        <p className="lh-prescription-print-title">Prescription</p>
        <p className="lh-prescription-print-meta">Generated {new Date().toLocaleDateString('en-GB')}</p>
      </div>
    </header>
  );
}

export function PrescriptionPrintDocument({ prescription, patient, practice }) {
  if (!prescription || !patient) return null;

  const medication = [
    prescription.drug || prescription.medication || prescription.name,
    prescription.strength,
    prescription.form,
  ].filter(Boolean).join(' ');
  const prescriber = prescription.prescriber || prescription.provider || prescription.doctor;
  const issued = prescription.issuedAt || prescription.issued || prescription.date || prescription.lastFilled;
  const pharmacy = prescription.pharmacy;
  const directions = [
    prescription.dose,
    prescription.route,
    prescription.directions || prescription.frequency,
  ].filter(Boolean).join(' | ');
  const quantity = prescription.quantity || prescription.dispenseQuantity || prescription.daysSupply;
  const duration = prescription.duration || prescription.daysSupply;
  const indication = prescription.indication || prescription.diagnosis || patient.conditions?.[0];
  const substitution = prescription.substitutionAllowed === false ? 'Do not substitute' : prescription.substitutionAllowed === true ? 'Substitution allowed' : 'Per pharmacist judgement';

  return (
    <div className="lh-print-prescription-doc" aria-hidden="true">
      <PracticeHeader practice={practice} />

      <section className="lh-prescription-print-grid">
        <div>
          <p className="lh-prescription-print-label">Patient</p>
          <p className="lh-prescription-print-strong">{patient.name}</p>
          <p>ID: {field(patient.id)}</p>
          <p>DOB: {field(patient.dob, 'Not recorded')}{ageFromDob(patient.dob) ? ` | ${ageFromDob(patient.dob)}` : ''}</p>
          <p>Sex: {field(patient.sex)}</p>
          {patient.phone && <p>Phone: {patient.phone}</p>}
        </div>
        <div>
          <p className="lh-prescription-print-label">Prescription ID</p>
          <p className="lh-prescription-print-strong">{field(prescription.id)}</p>
          <p>Status: {field(prescription.status)}</p>
          <p>Issued: {field(issued)}</p>
          <p>Indication: {field(indication)}</p>
        </div>
        <div>
          <p className="lh-prescription-print-label">Prescriber</p>
          <p className="lh-prescription-print-strong">{field(prescriber)}</p>
          <p>Registration: {field(prescription.prescriberRegistration || prescription.licenseNo)}</p>
          <p>{field(pharmacy, 'Dispense at patient pharmacy')}</p>
        </div>
      </section>

      <section className="lh-prescription-print-alerts">
        <div>
          <p className="lh-prescription-print-label">Allergies</p>
          <p>{patient.allergiesRecorded === false ? 'Not reviewed' : listField(patient.allergies, 'None known')}</p>
        </div>
        <div>
          <p className="lh-prescription-print-label">Current medicines</p>
          <p>{listField(patient.medications)}</p>
        </div>
      </section>

      <section className="lh-prescription-print-rx">
        <p className="lh-prescription-print-symbol">Rx</p>
        <div>
          <p className="lh-prescription-print-medication">{field(medication, 'Medication not recorded')}</p>
          <dl className="lh-prescription-print-details">
            <div>
              <dt>Directions</dt>
              <dd>{field(directions)}</dd>
            </div>
            <div>
              <dt>Quantity</dt>
              <dd>{field(quantity)}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{field(duration)}</dd>
            </div>
            <div>
              <dt>Refills</dt>
              <dd>{field(prescription.refills)}</dd>
            </div>
            <div>
              <dt>Next refill</dt>
              <dd>{field(prescription.nextRefill)}</dd>
            </div>
            <div>
              <dt>Substitution</dt>
              <dd>{substitution}</dd>
            </div>
          </dl>
        </div>
      </section>

      {prescription.notes && (
        <section className="lh-prescription-print-note">
          <p className="lh-prescription-print-label">Notes</p>
          <p>{prescription.notes}</p>
        </section>
      )}

      <footer className="lh-prescription-print-foot">
        <div className="lh-prescription-print-sign">
          <span />
          <p>Prescriber signature</p>
        </div>
        <div className="lh-prescription-print-stamp-box">Practice stamp</div>
        <p className="lh-prescription-print-small">
          Printed from Luminary Health. Verify medicine, dose, patient identity, and prescriber before dispensing.
        </p>
      </footer>
    </div>
  );
}

export default PrescriptionPrintDocument;

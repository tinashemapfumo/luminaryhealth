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

  const medication = [prescription.drug, prescription.strength].filter(Boolean).join(' ');
  const prescriber = prescription.prescriber || prescription.provider || prescription.doctor;
  const issued = prescription.issuedAt || prescription.issued || prescription.date || prescription.lastFilled;
  const pharmacy = prescription.pharmacy;

  return (
    <div className="lh-print-prescription-doc" aria-hidden="true">
      <PracticeHeader practice={practice} />

      <section className="lh-prescription-print-grid">
        <div>
          <p className="lh-prescription-print-label">Patient</p>
          <p className="lh-prescription-print-strong">{patient.name}</p>
          <p>{field(patient.id)}</p>
          <p>{field(patient.dob, 'DOB not recorded')}</p>
        </div>
        <div>
          <p className="lh-prescription-print-label">Prescription ID</p>
          <p className="lh-prescription-print-strong">{field(prescription.id)}</p>
          <p>Status: {field(prescription.status)}</p>
          <p>Issued: {field(issued)}</p>
        </div>
        <div>
          <p className="lh-prescription-print-label">Prescriber</p>
          <p className="lh-prescription-print-strong">{field(prescriber)}</p>
          <p>{field(pharmacy, 'Pharmacy not recorded')}</p>
        </div>
      </section>

      <section className="lh-prescription-print-rx">
        <p className="lh-prescription-print-symbol">Rx</p>
        <div>
          <p className="lh-prescription-print-medication">{field(medication, 'Medication not recorded')}</p>
          <dl className="lh-prescription-print-details">
            <div>
              <dt>Directions</dt>
              <dd>{field(prescription.directions || prescription.frequency)}</dd>
            </div>
            <div>
              <dt>Days supply</dt>
              <dd>{field(prescription.daysSupply)}</dd>
            </div>
            <div>
              <dt>Refills</dt>
              <dd>{field(prescription.refills)}</dd>
            </div>
            <div>
              <dt>Next refill</dt>
              <dd>{field(prescription.nextRefill)}</dd>
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
        <p className="lh-prescription-print-small">
          Printed from Luminary Health. Verify medicine, dose, patient identity, and prescriber before dispensing.
        </p>
      </footer>
    </div>
  );
}

export default PrescriptionPrintDocument;

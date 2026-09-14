/**
 * Column mapping.
 *
 * Every medical aid names its columns differently — `Tariff No.` / `Procedure`
 * / `Award` in one schedule, `Code` / `Description` / `Rate` in the next — and
 * neither is wrong. So the import never assumes a layout: it asks which column
 * means what, and remembers the answer as a profile so the same payer's next
 * upload maps itself.
 */

/** The fields a tariff import has to end up with. */
export const TARIFF_FIELDS = [
  { key: 'tariffCode', label: 'Tariff code', required: true },
  { key: 'serviceName', label: 'Service name', required: true },
  { key: 'rate', label: 'Rate', required: true },
  { key: 'description', label: 'Description', required: false },
  { key: 'currency', label: 'Currency', required: false },
  { key: 'plan', label: 'Plan', required: false },
  { key: 'effectiveFrom', label: 'Effective from', required: false },
  { key: 'effectiveTo', label: 'Effective to', required: false },
];

/** The fields a service catalogue import has to end up with. */
export const SERVICE_FIELDS = [
  { key: 'serviceName', label: 'Service name', required: true },
  { key: 'practicePrice', label: 'Practice price', required: false },
  { key: 'billingDescription', label: 'Billing description', required: false },
  { key: 'category', label: 'Category', required: false },
  { key: 'department', label: 'Department', required: false },
  { key: 'currency', label: 'Currency', required: false },
  { key: 'billingTrigger', label: 'Billing trigger', required: false },
  { key: 'tariffCode', label: 'Default tariff code', required: false },
  { key: 'orderable', label: 'Orderable', required: false },
  { key: 'active', label: 'Active', required: false },
];

export const IMPORT_KINDS = {
  TARIFF: { id: 'tariff', label: 'Medical aid tariffs', fields: TARIFF_FIELDS },
  SERVICE: { id: 'service', label: 'Service catalogue', fields: SERVICE_FIELDS },
};

const normalise = (value) =>
  String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Header spellings seen in the wild, per field.
 *
 * A first guess only — it pre-fills the mapping screen so an administrator
 * confirms rather than types, and every guess stays editable. Guessing without
 * showing the result would be how a column named "Award" silently becomes a
 * price nobody checked.
 */
const HINTS = {
  tariffCode: ['tariffcode', 'tariffno', 'tariffnumber', 'code', 'itemcode', 'procedurecode', 'nappicode'],
  serviceName: ['servicename', 'service', 'procedure', 'description', 'item', 'itemdescription', 'proceduredescription'],
  rate: ['rate', 'award', 'amount', 'price', 'tariffamount', 'benefit', 'fee'],
  description: ['description', 'longdescription', 'detail', 'notes'],
  currency: ['currency', 'ccy', 'curr'],
  plan: ['plan', 'option', 'benefitoption', 'scheme', 'planname'],
  effectiveFrom: ['effectivefrom', 'validfrom', 'datefrom', 'startdate', 'from', 'effectivedate'],
  effectiveTo: ['effectiveto', 'validto', 'dateto', 'enddate', 'to'],
  practicePrice: ['practiceprice', 'price', 'amount', 'fee', 'charge'],
  billingDescription: ['billingdescription', 'invoicedescription', 'billingname'],
  category: ['category', 'group', 'type'],
  department: ['department', 'dept', 'unit'],
  billingTrigger: ['billingtrigger', 'trigger', 'billwhen'],
  orderable: ['orderable', 'clinicalorder', 'canorder', 'orderenabled'],
  active: ['active', 'enabled', 'status'],
};

/**
 * Guess a mapping from the file's own headers.
 *
 * `serviceName` and `description` both list "description" as a spelling,
 * because a schedule with one text column means it as the service. Fields are
 * resolved in declaration order and a header is consumed once, so the more
 * specific field claims it first and the looser one is left unmapped rather
 * than duplicating it.
 */
export function guessMapping(headers = [], fields = TARIFF_FIELDS) {
  const taken = new Set();
  const mapping = {};

  fields.forEach((field) => {
    const hints = HINTS[field.key] ?? [];
    const match = headers.find(
      (header) => !taken.has(header) && hints.includes(normalise(header))
    );
    if (match) {
      mapping[field.key] = match;
      taken.add(match);
    }
  });

  return mapping;
}

/** Apply a mapping to one parsed row, producing the canonical field names. */
export function applyMapping(row, mapping) {
  const out = { __line: row.__line };
  Object.entries(mapping).forEach(([field, header]) => {
    if (header) out[field] = row[header];
  });
  return out;
}

/** Which required fields the administrator has not yet mapped. */
export function missingRequired(mapping, fields = TARIFF_FIELDS) {
  return fields.filter((field) => field.required && !mapping[field.key]).map((field) => field.label);
}

/**
 * A saved mapping profile.
 *
 * Keyed by payer and remembered, so "CIMAS Tariff Import" is configured once
 * and every later upload from that payer maps itself. `headerSignature` records
 * the layout it was built against — when a payer changes their export format
 * the profile still applies, but the screen can say that it no longer matches.
 */
export function makeProfile({ name, kind, payerId, mapping, headers, createdBy }) {
  return {
    id: `MAP-${Date.now().toString(36).toUpperCase()}`,
    name,
    kind,
    payerId: payerId ?? null,
    mapping,
    headerSignature: [...headers].sort().join('|'),
    createdBy,
    createdAt: new Date().toISOString(),
  };
}

export const profileMatchesHeaders = (profile, headers = []) =>
  profile.headerSignature === [...headers].sort().join('|');

/**
 * A description an administrator has confirmed points at a service.
 *
 * §13's "save the imported description as an alias" — the mechanism that stops
 * the same schedule needing the same manual decision every month. Recorded
 * with who approved it and where it came from, because an alias silently
 * changes what a later import maps to and that has to be attributable.
 */
export function makeAlias({ serviceId, alias, source, payerId, approvedBy }) {
  return {
    id: `ALS-${Date.now().toString(36).toUpperCase()}`,
    serviceId,
    alias: String(alias ?? '').trim(),
    source: source ?? 'import',
    payerId: payerId ?? null,
    approvedBy,
    approvedAt: new Date().toISOString(),
  };
}

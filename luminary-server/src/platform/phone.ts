/**
 * Comparing telephone numbers.
 *
 * WhatsApp sends `263771234567`, a practice records `+263 77 123 4567`, and the
 * patient wrote it on an intake form as `077 123 4567`. All three are the same
 * person and none of them is stored the same way.
 *
 * Comparing the last nine digits matches all three without pretending to parse
 * dialling plans — a full E.164 normaliser needs a country database and would
 * fail differently, not less. Nine because a Zimbabwean subscriber number is
 * nine digits after the country code.
 *
 * Deliberately no fuzzy fallback. Matching on fewer digits would start pairing
 * unrelated people, and the failure mode there is one patient's medical
 * conversation filed in another patient's record — far worse than a message
 * somebody has to route by hand.
 *
 * Kept free of database and configuration imports so it can be exercised
 * directly, which is also why it is here rather than beside the service that
 * uses it.
 */

/** The comparable tail of a number, or the whole thing when it is too short. */
export const numberKey = (value: string): string => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : digits;
};

/** Whether two spellings denote the same subscriber. Short numbers never match. */
export const sameNumber = (a: string, b: string): boolean => {
  const left = numberKey(a);
  return left.length >= 9 && left === numberKey(b);
};

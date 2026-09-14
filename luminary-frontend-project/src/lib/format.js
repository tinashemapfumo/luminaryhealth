import { FALLBACK_CURRENCY } from './money.js';

/**
 * Whole-unit money, for the many places that print a figure without needing
 * the two-decimal precision a receipt does.
 *
 * Takes its code rather than naming one. This used to be
 * `` `ZWL ${value}` ``, which meant every screen in the workspace announced a
 * currency the practice may never have quoted in — Bulawayo Family Practice
 * has been configured `USD` primary since the settings existed and still had
 * ZWL printed on every figure it drew. The code now comes from
 * `profile.primaryCurrency`, so changing it in Settings changes the workspace.
 */
export const formatWhole = (value, code = FALLBACK_CURRENCY) =>
  `${code} ${Number(value).toLocaleString('en-US')}`;

/** Bound to one practice's billing currency; the workspace publishes this. */
export const currencyFor = (code) => (value) => formatWhole(value, code);

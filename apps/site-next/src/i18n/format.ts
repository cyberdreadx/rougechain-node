/**
 * Locale-aware display formatting (Intl) for the selected language.
 *
 * Use these for counts, heights, sizes, percentages, prices and dates. Do NOT use them for
 * on-chain token amounts shown for review/signing, addresses, hashes or anything a user may copy
 * back into an input: those stay exact and unlocalised (@rougechain/chain-readonly's
 * formatTokenAmount keeps en-US grouping, as apps/web did).
 *
 * Call during render (components that call useTranslation re-render on a language change).
 */
import { currentLocale } from "./index";

/** Integer / plain number with locale grouping (block heights, counts, bytes). */
export function fmtInt(n: number): string {
  return new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 0 }).format(n);
}

/** Number with up to `maxDigits` fraction digits (display values: prices, percentages, stats). */
export function fmtNum(n: number, maxDigits = 2, opts: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: maxDigits, ...opts }).format(n);
}

type DateInput = Date | number | string;
const asDate = (d: DateInput) => (d instanceof Date ? d : new Date(d));

/** Date + time (default: medium date, short time). */
export function fmtDateTime(d: DateInput, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  return new Intl.DateTimeFormat(currentLocale(), opts).format(asDate(d));
}

/** Date only (default: medium). */
export function fmtDate(d: DateInput, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" }): string {
  return new Intl.DateTimeFormat(currentLocale(), opts).format(asDate(d));
}

/** Time only (default: hours + minutes). */
export function fmtTime(d: DateInput, opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" }): string {
  return new Intl.DateTimeFormat(currentLocale(), opts).format(asDate(d));
}

/** Relative time ("3 minutes ago", "hace 3 minutos", "3 分钟前", "3 分前") from a timestamp. */
export function fmtRelative(from: DateInput, now: number = Date.now(), style: Intl.RelativeTimeFormatStyle = "long"): string {
  const secs = Math.round((asDate(from).getTime() - now) / 1000);
  const abs = Math.abs(secs);
  const rtf = new Intl.RelativeTimeFormat(currentLocale(), { numeric: "auto", style });
  if (abs < 60) return rtf.format(secs, "second");
  if (abs < 3600) return rtf.format(Math.round(secs / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(secs / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(secs / 86400), "day");
  if (abs < 86400 * 365) return rtf.format(Math.round(secs / (86400 * 30)), "month");
  return rtf.format(Math.round(secs / (86400 * 365)), "year");
}

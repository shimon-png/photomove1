/**
 * Normalizes a phone number to E.164 (+15551234567). Accepts numbers with a
 * leading + and country code; a bare 10-digit number is treated as US/Canada.
 * Returns null when it can't be interpreted.
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** For display without exposing the whole number: "•••• 4567". */
export function maskPhone(e164: string): string {
  return `•••• ${e164.slice(-4)}`;
}

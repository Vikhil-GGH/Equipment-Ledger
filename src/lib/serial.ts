/**
 * The comparison key for a serial number — the same rule as the database's
 * normalize_serial() (supabase/migrations/20260901000027_inventory_integrity.sql):
 * trim leading/trailing whitespace (incl. non-breaking spaces), collapse any
 * internal run of whitespace to one space, upper-case. "abc123", " ABC123 "
 * and "ABC123" are one device; "ABC 123" and "ABC  123" are one device;
 * "ABC123" and "ABC 123" are two. The serial as typed is kept for display.
 */
export function normalizeSerial(serial: string | null | undefined): string {
  return (serial ?? '').replace(/[\s ]+/g, ' ').trim().toUpperCase()
}

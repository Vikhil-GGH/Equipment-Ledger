import { describe, expect, it } from 'vitest'
import { normalizeSerial } from './serial'

// Must agree with normalize_serial() in the database (the same cases are
// asserted there in supabase/tests/db/integrity.db.test.ts).
describe('normalizeSerial', () => {
  it.each([
    ['ABC123', 'ABC123'],
    ['abc123', 'ABC123'],
    ['  ABC123 ', 'ABC123'],
    ['\tabc123\n', 'ABC123'],
    [' ABC123 ', 'ABC123'],
    ['ABC 123', 'ABC 123'],
    ['ABC   123', 'ABC 123'],
    ['ABC\t 123', 'ABC 123'],
    ['   ', ''],
  ])('%j → %j', (input, key) => {
    expect(normalizeSerial(input)).toBe(key)
  })

  it('a space inside a serial is significant', () => {
    expect(normalizeSerial('ABC123')).not.toBe(normalizeSerial('ABC 123'))
  })

  it('treats a missing serial as blank', () => {
    expect(normalizeSerial(null)).toBe('')
    expect(normalizeSerial(undefined)).toBe('')
  })
})

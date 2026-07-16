import { describe, expect, it } from 'vitest'
import { descriptionSimilarity } from '@/lib/textSimilarity'

describe('descriptionSimilarity', () => {
  it('returns 1 for identical strings (case-insensitive)', () => {
    expect(descriptionSimilarity('Hospital Visit', 'hospital visit')).toBe(1)
  })

  it('returns 0.9 when one string contains the other', () => {
    expect(descriptionSimilarity('Dubai Vet Clinic', 'Dubai Vet Clinic refund')).toBe(0.9)
  })

  it('scores unrelated strings low', () => {
    expect(descriptionSimilarity('Hospital Visit', 'Grocery Store')).toBeLessThan(0.4)
  })

  it('is symmetric', () => {
    expect(descriptionSimilarity('Vet Clinic', 'Clinic Vet')).toBe(descriptionSimilarity('Clinic Vet', 'Vet Clinic'))
  })
})

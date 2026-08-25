import { SpeakerBoundsSchema } from '../src/meetings/speaker-bounds';

describe('SpeakerBoundsSchema', () => {
  it('accepts min/max, either alone', () => {
    expect(SpeakerBoundsSchema.parse({ min: 2, max: 5 })).toEqual({ min: 2, max: 5 });
    expect(SpeakerBoundsSchema.parse({ min: 3 })).toEqual({ min: 3 });
    expect(SpeakerBoundsSchema.parse({ max: 3 })).toEqual({ max: 3 });
  });
  it('rejects empty, min > max, zero, non-integer, above cap, unknown keys', () => {
    for (const bad of [{}, { min: 5, max: 2 }, { min: 0 }, { max: 2.5 }, { max: 21 }, { count: 3 }]) {
      expect(SpeakerBoundsSchema.safeParse(bad).success).toBe(false);
    }
  });
  it('names the field on failure', () => {
    const r = SpeakerBoundsSchema.safeParse({ min: 5, max: 2 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/min.*max/);
  });
});

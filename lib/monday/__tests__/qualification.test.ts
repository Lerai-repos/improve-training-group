import { describe, expect, it } from 'vitest';

import { deriveEffective } from '../qualification';

describe('deriveEffective', () => {
  it('maps groen→green and rood→red', () => {
    expect(deriveEffective(['groen'])).toEqual({ effective: 'green', conflict_resolution: null });
    expect(deriveEffective(['rood'])).toEqual({ effective: 'red', conflict_resolution: null });
  });

  it('leaves oranje/grijs effective null (unconfirmed mapping)', () => {
    expect(deriveEffective(['oranje'])).toEqual({ effective: null, conflict_resolution: null });
    expect(deriveEffective(['grijs'])).toEqual({ effective: null, conflict_resolution: null });
  });

  // grijs is "not assessed", so it must not compete with a real colour. Without
  // this, the 30-July groen/rood migration (which left trainers in BOTH grijs and
  // their new colour) makes ~380 pairs conflict → effective null → those trainers
  // silently drop out of every recommendation.
  it('lets a real colour win over grijs instead of conflicting', () => {
    expect(deriveEffective(['groen', 'grijs'])).toEqual({
      effective: 'green',
      conflict_resolution: null,
    });
    expect(deriveEffective(['rood', 'grijs'])).toEqual({
      effective: 'red',
      conflict_resolution: null,
    });
  });

  it('records a conflict (multiple colours) and leaves effective null', () => {
    expect(deriveEffective(['groen', 'rood'])).toEqual({
      effective: null,
      conflict_resolution: { colours: ['groen', 'rood'] },
    });
  });
});

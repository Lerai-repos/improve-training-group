# M2b vs legacy Airtable Aanbevelingen — parity

Sample: 12 trainings present in both the legacy Aanbevelingen snapshot and the current Monday board.
Travel is stubbed (eligibility is pre-travel); this compares the recommended trainer SETS.

**Expected divergence:** M2b is green-only (client collapsed the stoplicht); legacy allowed Oranje.
So an only-legacy trainer whose legacy Qualification contained Oranje/Grijs/Rood is an EXPECTED
exclusion. Only a pure-Groen only-legacy trainer, or an only-M2b trainer, is a real diff (usually
board drift since the July snapshot).

## Aggregate
- matched (in both): **125**
- only-legacy, colour-excluded (expected — oranje/grijs/rood): **59**
- only-legacy, pure-groen (REVIEW — drift or discrepancy): **2**
- only-M2b (new green / board drift): **1**
- M2b FOUT on this training: **0**

## Per training
| Training | M2b status | legacy # | m2b # | matched | diff |
|---|---|---|---|---|---|
| 2895177854 | GEREED | 15 | 9 | 9 | +0 / -6(oranje) / -0(?) |
| 2888847170 | GEREED | 19 | 14 | 13 | +1 / -5(oranje) / -1(?) |
| 3084042054 | GEREED | 12 | 11 | 11 | +0 / -1(oranje) / -0(?) |
| 3032386245 | GEREED | 14 | 9 | 9 | +0 / -4(oranje) / -1(?) |
| 3004911025 | GEREED | 8 | 5 | 5 | +0 / -3(oranje) / -0(?) |
| 2901036173 | GEREED | 17 | 13 | 13 | +0 / -4(oranje) / -0(?) |
| 2997114095 | GEREED | 18 | 10 | 10 | +0 / -8(oranje) / -0(?) |
| 2964395720 | GEREED | 11 | 8 | 8 | +0 / -3(oranje) / -0(?) |
| 2998803536 | GEREED | 18 | 10 | 10 | +0 / -8(oranje) / -0(?) |
| 2901041078 | GEREED | 17 | 13 | 13 | +0 / -4(oranje) / -0(?) |
| 2855309183 | GEREED | 19 | 15 | 15 | +0 / -4(oranje) / -0(?) |
| 5069247896 | GEREED | 18 | 9 | 9 | +0 / -9(oranje) / -0(?) |

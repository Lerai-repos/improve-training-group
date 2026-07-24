# M2a — Monday mapping audit (sanitized)

> Reproducible via `pnpm audit:mapping`. Aggregate counts + anomaly ids + input hashes.
> Raw PII dumps stay under gitignored `snapshots/`; this report is committed evidence.

## Comparison rules

- Klant identity key: NFC + trim + collapse whitespace (no `(copy)`/case merge).
- Alias fingerprint (diagnostic only): + lowercase + strip trailing `(copy)`.
- Empty relation = OK; unresolved ref = fatal. Numeric non-parse = fatal.
- Qualification source = Themas board (4 colours); Trainers board = cross-check.

## Input hashes

- `agenda-2026.json`: sha256 `35790fc98c20827a84baef0c17684785f901185eab36c31f7bc0640ac13e9acf`
- `trainers.json`: sha256 `5593f06665007f81c8b10adbb5df3cd363941b3598f0d7d72e4c7b1480a71dca`
- `themas.json`: sha256 `c2105af73c3f1fd5debcd3b027673f5ff497b27338558df45b163c7baf4bf092`
- `schema.json`: sha256 `b9692ad66dff3fd8a3a5dd1e75420babe3f69f4fe927801584f45be53c1378d6`

## Monday↔Airtable cross-diff (join on Monday Pulse ID)

Airtable inputs (sha256):
- `trainingen.json` `435a20c8b06efcb43509b9a73da029788a5e62fcbcce7eac6ab52c8a3131c0e7`
- `trainers.json` `ca87a7a36eaf3c8a4f2e7d3c00fc32613c51fbed5379b2c3fecf373d72c9f52b`
- `themas.json` `49a41cacebc28291f3bd1341f8397c54bab9e6b57a9890c8bf07d9c8f79a90be`

Duplicate join ids: none.

> The Airtable snapshot is fase-1 processed output (possibly stale vs the live board) —
> field diffs are expected drift, reported for review, not a pass/fail gate.

- **trainings (2026)**: Monday 756, Airtable 722, matched 714, only-Monday 42, only-Airtable 8
  - only-Monday ids: 1835734264, 2797648538, 2797649830, 2797650134, 1855178852, 1997502623, 2522129367, 2540890849, 2732683527, 2758849147, 2778821264, 2806996412, 2825042503, 2829971285, 2856691672, 2926669428, 2960696075, 2960713698, 3010865000, 5010307418, 5045475457, 5038868180, 3036041084, 2985334759, 2977229498 …
  - only-Airtable ids: 2806799245, 2692057849, 2763908771, 2770313088, 2599197764, 2806799075, 2641244969, 1732205304
- **trainers**: Monday 171, Airtable 172, matched 170, only-Monday 1, only-Airtable 2
  - only-Monday ids: 2638479433
  - only-Airtable ids: 2617337163, 2145201787
- **themas**: Monday 102, Airtable 101, matched 101, only-Monday 1, only-Airtable 0
  - only-Monday ids: 2602325316

### Field-level comparison — trainings (Monday vs Airtable snapshot)

- **datum**: compared 714, agree 708, differ 6
  - e.g. 2776974680: M="" A="2026-05-28" | 2781797988: M="" A="2026-06-25" | 2948882502: M="2026-10-08" A="2026-10-01" | 3023292006: M="2026-10-19" A="2026-08-24" | 2672753693: M="" A="2026-05-28"
- **duur**: compared 710, agree 687, differ 23
  - e.g. 2012942877: M="4" A="" | 2749835148: M="4" A="" | 2708184664: M="" A="0" | 2732542489: M="4" A="0" | 2820966458: M="" A="0"
- **omzet**: compared 714, agree 586, differ 128
  - e.g. 2506687133: M="1995" A="" | 2595099509: M="1740" A="995" | 2738745555: M="1245" A="" | 2681156635: M="2490" A="" | 2749835148: M="1400" A=""
- **taal**: compared 713, agree 493, differ 220
  - e.g. 5064359658: M="NL" A="" | 5035923166: M="NL" A="" | 2511330050: M="NL" A="" | 2577989000: M="NL" A="" | 5040999795: M="NL" A=""
- **tijd**: compared 702, agree 442, differ 260
  - e.g. 2991864410: M="15:30 - 17:30" A="N.O.T.K." | 5064359658: M="10:00 - 11:00" A="" | 5035923166: M="13.00 - 17.00 uur" A="" | 2511330050: M="09:30 -11:30 uur" A="" | 2577989000: M="09.00-11.00 uur" A=""
- **locatie**: compared 703, agree 374, differ 329
  - e.g. 5029726254: M="Duinweg 1 3735 LA Bosch en Duin" A="Bosch en Duin" | 2813470272: M="Jonkerbosplein 52, 6534 AB Nijmegen" A="Nijmegen" | 2984038161: M="Verbindelaarsweg 138 in Ede (Loft Kazerne)" A="Ede" | 5069247896: M="City Post, Westerlaan 111, 8011 CA Zwolle" A="" | 2913647369: M="Schuttersveld 17,7514 A C Enschede" A="Enschede"
- **bedrijf**: compared 713, agree 664, differ 49
  - e.g. 2984038161: M="" A="De Heus (copy)" | 5020023836: M="COA via Radar Vertige" A="COA via Radar Vertige (copy)" | 5020033702: M="COA via Radar Vertige" A="COA via Radar Vertige (copy) (copy)" | 2032096774: M="NBD Biblion" A="NBD Biblion (copy)" | 2527961860: M="Repair care" A="Repair Care"

### Field-level comparison — trainers (Monday vs Airtable snapshot)

- **naam**: compared 170, agree 170, differ 0
- **adres**: compared 114, agree 114, differ 0
- **email**: compared 139, agree 136, differ 3
  - e.g. 1661151163 | 5065177070 | 1862840632
- **telefoon**: compared 146, agree 146, differ 0

### Field-level comparison — themas (Monday vs Airtable snapshot)

- **thema**: compared 101, agree 101, differ 0

### Not compared (deliberate omissions)

- training→trainer/thema relation membership: Airtable trainingen carries no Monday trainer
  link and its Thema links use Airtable record ids (not Monday ids), so per-pair membership
  is not comparable here — it IS validated at sync time (unresolved refs are fatal).
- ie_code / label / status: derived or not present in the Airtable snapshot.
- evaluation snapshots (avg_*): owned by M3 (Google Sheets), out of M2a scope.

## Agenda 2026 (trainings)

- rows: **756**
- klant (item-name vs Bedrijf mirror): equal **586**, differ **152**, no-Bedrijf **18**
- relations: no-trainer **68**, multi-trainer **80**, no-thema **56**
- fields: no-datum **39**, no-duur **33** (malformed 0), no-omzet **1** (malformed 0)

### Klant alias candidates (fatal until decided): **1**

- `de heus` → "De Heus" | "De Heus (copy)"

### No-Bedrijf items needing an acknowledged klant mapping: **18**

  - `2984038161` — item name: "De Heus (copy)"
  - `2658618672` — item name: "Buro Payroll"
  - `2572131551` — item name: "Rechtbank Den Haag"
  - `2710887956` — item name: "DKH"
  - `2813466986` — item name: "Stichting Aap"
  - `2879187666` — item name: "Stichting Aap"
  - `2879208237` — item name: "Stichting Aap"
  - `2855141447` — item name: "Flott management"
  - `2056629347` — item name: "RDW"
  - `2577919874` — item name: "Antoni van Leeuwenhoek ziekenhuis"
  - `2857389551` — item name: "Nationaal Media Onderzoek"
  - `2912945874` — item name: "Crocs - Laura"
  - `2879187907` — item name: "Stichting Aap"
  - `2610564558` — item name: "De Heus (copy)"
  - `2976054283` — item name: "Nationaal Media Onderzoek"
  - `2542930114` — item name: "De Heus"
  - `2775941317` — item name: "Incotec"
  - `2661874469` — item name: "Coaching Aleksandra"

## Trainers

- rows: **171**
- no-address **57**, no-email **32**

### Groups (drives rate/eligibility policy)

- **39** — `group_mksf680e` :: Eenmalige samenwerkingen
- **28** — `group_mm0d6p4r` :: Schaduwpool
- **25** — `group_mkxyf1vc` :: Inactief/uit dienst
- **22** — `group_mkyf5hff` :: Niet meer inzetten / Niet goed gepresteerd / Te duur
- **19** — `nieuwe_groep__1` :: Trainers instroom 2024 - Heden
- **18** — `topics` :: Trainers instroom 2020-2024
- **15** — `nieuwe_groep22164__1` :: Acteurs
- **3** — `nieuwe_groep83821__1` :: Externe leveranciers
- **1** — `nieuwe_groep29713__1` :: Interne trainers
- **1** — `group_mkznwnev` :: !!!!!NIET VERWIJDEREN!!!!

## Qualifications

- Themas board pairs by colour: groen 915, oranje 466, rood 1319, grijs 855
- Non-grijs pairs — Themas board **2691** vs Trainers board **2691**; only-Themas **0**, only-Trainers **0** (0/0 = true agreement)
- **Colour conflicts (fatal until allowlisted): 9**

  - `1661151187::5072550356` → groen, rood
  - `1661151229::5072549551` → groen, rood
  - `1661151163::5072549569` → groen, rood
  - `1661151229::5072549257` → groen, rood
  - `1661151163::5072549368` → groen, rood
  - `1661151163::5072549266` → groen, oranje
  - `2088658159::5072549363` → oranje, rood
  - `1661151187::5072549363` → oranje, rood
  - `1835035504::5072549363` → oranje, rood


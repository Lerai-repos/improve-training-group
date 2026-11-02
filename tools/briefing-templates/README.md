# Briefing-sjablonen bouwen

Eenmalige tool. Zet ITG's `.dotx` om naar de sjablonen die `docx-templates` invult, en
schrijft het resultaat naar `lib/briefing/templates/<LABEL>.docx`.

```bash
SRC="docs/Improve Training Group/Shared/Briefing bestanden"
for L in CC CP FT FV IT JE SST TT WJ; do
  python3 tools/briefing-templates/convert.py "$SRC/ITG Bron - $L - Briefing.dotx" /tmp/stage.docx
  python3 tools/briefing-templates/body.py /tmp/stage.docx "lib/briefing/templates/$L.docx"
done
```

## Twee stappen, met opzet

`convert.py` doet de **gegevenstabel**: de 16 rijen in de v2.0-volgorde, elk met een
`+++veld+++`. Het voegt de twee rijen toe die ITG nooit had (`Klanttitel`,
`Materialen uiterlijk op`; bij CC ook `Trainingslocatie`).

`body.py` doet de **secties die lijsten zijn**: achtergrondinformatie, Extra informatie
trainer, de programmabullets, de conditionele blokken en de inventarisatie. Allemaal een
`FOR`-lus, zodat de CODE bepaalt wát erin komt en in welke volgorde, en het sjabloon alleen
zegt wáár.

## Wat je moet weten voor je hieraan sleutelt

**De intro en de gegevenstabel worden uit hun tekstvak getild** (24-Aug-2026). ITG's `.dotx`
zet ze in een zwevend tekstvak; hun eigen verstuurde briefings niet — gemeten op
`2.0 ITG vb Briefing Probiblio`: intro op body 45-55, tabel op body 62. Alleen de disclaimer
en de kopband `Algemeen.` blijven ook bij hen een tekstvak, en dus bij ons.

Waarom: een tekstvak is in Word een tekenobject in plaats van klik-en-typ, en **Google Docs
laat het bij importeren volledig weg** — daar verdween de hele gegevenstabel. De adviseur
bewerkt deze documenten, dus dat is geen schoonheidsfoutje.

Het optillen verwijdert meteen de `mc:Fallback`-kopie, want die is een tweede exemplaar van
dezelfde inhoud en zou na het optillen dubbel in het document staan. Daarom verwacht
`convert.py` ná het optillen nog **één** gegevenstabel, en telt `body.py` elke ankertekst
**één** keer.

**De ankeralinea blijft leeg staan.** De overige tekstvakken op die pagina zijn
gepositioneerd `relativeFrom="paragraph"` en schuiven dus mee met hun anker. Zou de
opgetilde inhoud vóór het anker komen, dan zakt de kopband `Algemeen.` de pagina af en
verdwijnt de disclaimer eronderuit. Het pagina-einde verhuist mee naar áchter de opgetilde
inhoud, anders belandt die een pagina te laat.

De intro krijgt 1,9 cm ruimte erboven: dat was de eigen V-offset van zijn tekstvak, nodig
omdat de kopband `Algemeen.` tot 1 cm onder de bovenmarge doorloopt.

**De eerste rij heet per label anders**: Training, Workshop, Teambuilding of Cursus. Die
wordt op aliassen gematcht en de eigen schrijfwijze van het sjabloon blijft staan. CC had
`Cursusslocatie` en `Cursusscode MC` met een dubbele s; die twee typefouten corrigeren we.

**`xmlkeep.py` is niet optioneel.** ElementTree schrijft alleen de namespaces die het
gebruikt, maar `mc:Ignorable` noemt tien prefixes die *gedeclareerd* moeten blijven. Laat je
die vallen, dan noemt Word het bestand beschadigd — stil, tot iemand het opent.

**`.dotx` → `.docx` vereist het content-type in `[Content_Types].xml`.** Getest: mét de
herschrijving opent Word het correct, zónder meldt Word schade.

**Controleer output in Word, niet in de VS Code-preview.** Die toont geen zwevende
afbeeldingen, dus elk voorblad lijkt te ontbreken — ook in ITG's eigen onbewerkte sjabloon.

## Stap drie: de teksten naar het bord (30-Sep-2026)

Sinds 30-Sep-2026 beheert ITG elke tekst in de briefing zelf, op het Monday-bord
Briefingteksten (`lib/briefingteksten/`). `teksten.py` haalt die teksten uit de sjablonen en zet
er lussen voor in de plaats: de algemene tekst onder `Algemeen.`, de cyaan Monday
Challenges-regel, kop en inleiding van `Concept inhoud` en `Inventarisatie klant`, en de zin
voor een niet ingevuld formulier. Elke bloktitel komt achter een `IF`, want ITG mag een kop
leegmaken.

```bash
python3 tools/briefing-templates/teksten.py
```

Draait op de **bestaande** sjablonen, niet op ITG's `.dotx`: de grijze labelcellen en de links
uitgelijnde tabel (22-Sep-2026) zijn met de hand in die bestanden gezet. Genereer je de
sjablonen ooit opnieuw met `convert.py` + `body.py`, zet die twee dingen dan terug en draai
daarna `teksten.py`. Een sjabloon dat al is omgezet slaat hij over.

De ruimte onder de kopband `Algemeen.` (1,9 cm) staat op een eigen, 1 pt hoge alinea vóór de
lus, niet meer op de inleiding: die kan ITG leegmaken.

`verify-blocks.py` is daarbij vervallen. Die legde de blokteksten in `blocks.ts` naast ITG's
bronbestand; die teksten zijn nu de beginwaarden van het bord, en daarna zijn ze van ITG.

## Stap vier: de volgorde (12-Oct-2026)

Dirkje wil eerst het concept programma en dan pas de teksten voor de rol. `volgorde.py`
verplaatst in de bestaande sjablonen de rolblokkenlus naar vlak boven de overige blokken:

```bash
python3 tools/briefing-templates/volgorde.py
```

Volgorde daarna: `Concept inhoud` (kop, inleiding, bullets) → rolblokken → overige blokken →
`Inventarisatie klant`. Een sjabloon dat al goed staat slaat hij over. Genereer je ooit opnieuw
met `convert.py` + `body.py`, draai dan `teksten.py` en daarna dit.

## Stap vijf: vette kopjes in de achtergrond (12-Oct-2026)

`lib/briefing/alineas.ts` haalt ITG's vaste kopjes ("De aanleiding", "De deelnemersgroep", …) los
uit de achtergrondtekst en markeert ze. `achtergrond-koppen.py` geeft de achtergrondlus een vette
variant voor die regels:

```bash
python3 tools/briefing-templates/achtergrond-koppen.py
```

Volgorde na opnieuw genereren: `teksten.py`, `volgorde.py`, dan dit.

## Stap zes: de inventarisatie zoals ITG's voorbeeld (13-Oct-2026)

Elke vraag van het inventarisatieformulier vet, het antwoord eronder, en een witregel tussen twee
paren:

```bash
python3 tools/briefing-templates/inventarisatie-opmaak.py
```

## Stap zeven: het algemene sjabloon (13-Oct-2026)

ITG voegt zelf labels toe op het Labels-bord. Zo'n label heeft geen eigen sjabloon en krijgt
`_algemeen.docx`: een kopie van `IT.docx` waarin de twee logo's (voorblad en voettekst) de
relatie-id `rIdLabelLogo` en een leeg plaatje hebben, en het woord "Training" in de gegevenstabel
`+++term+++` is. Bij het renderen zet `lib/briefing/logo.ts` het logo van het Labels-bord erin.

```bash
python3 tools/briefing-templates/algemeen.py
```

**Draai dit als laatste**, na elke stap die alle sjablonen omzet: het script kopieert `IT.docx`
opnieuw, dus een omzetting van daarvoor komt vanzelf mee, en een van daarna niet.

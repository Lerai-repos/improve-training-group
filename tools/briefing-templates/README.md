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

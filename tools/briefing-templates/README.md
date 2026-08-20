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

**De hele gegevenstabel zit in een Word-tekstvak.** De inhoud daarvan staat twee keer in de
XML, in `mc:Choice` én `mc:Fallback`. Beide converters passen daarom elke tabel aan die ze
vinden, niet alleen de eerste. `docx-templates` vult beide takken correct in.

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

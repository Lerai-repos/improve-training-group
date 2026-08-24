"""
Haalt de 85 thema-skeletten uit `ITG - Training skeletten 2024.docx`.

Het bronbestand is met de hand onderhouden en dat is te zien. Drie dingen moeten eruit
voordat de tekst bruikbaar is, en alle drie zijn gemeten en niet aangenomen:

1. **De `xx`-markeringen.** Dirkje: *"In Canva wordt de opmaak gewist en was het daarom
   niet opvallend dat organisatienaam moest worden aangepast, net als welke afspraken.
   Daarom hebben we soms die xx'jes erin gezet."* Ze staan dus **om** het variabele stuk
   heen, als losse alinea's. Twee vormen, allebei gemeten:

       Reflectie: ... binnen        Uitgebreid oefenen ... inzichten.
       xx                           xxx
       organisatienaam              Welke afspraken en verbeteringen ...?
       xx                           xxx
       en binnen deze groep?        Next step: ...

   In de eerste vorm staat soms géén `organisatienaam` tussen de markeringen; dan **is**
   de markering zelf de plaatshouder (`Mopperen`, `Omgaan met generatie Z`).

2. **Alinea's die midden in een zin zijn afgebroken.** Enter in plaats van doorlopen.
   Ze worden weer aan elkaar geplakt als de vorige alinea niet op leesteken eindigt.

3. **Acht schrijfwijzen van dezelfde plaatshouder** (`organisatienaam` 66x, `xx` 16x,
   `XXX` 5x, `XX` 3x, `Xx` 4x, `Xxx`, `xxx`, `ORGANISATIENAAM`). Die worden alle acht
   `{organisatie}`, zodat er in Monday één ding staat dat wij kunnen invullen.

Gebruik:

    python3 tools/skeletten/extract.py <docx> tools/skeletten/skeletten.json
"""

import copy
import json
import re
import sys
import unicodedata
import zipfile
from xml.etree import ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'

#: Het aantal thema's in het bronbestand. Wijkt de telling af, dan is het bestand
#: veranderd en moet de kaart in `thema-map.json` opnieuw langs.
EXPECTED_THEMES = 85

#: Een alinea die alleen uit x-en bestaat: een markering, geen inhoud.
MARKER = re.compile(r'^[xX]{1,3}$')

#: De plaatshouder zoals hij voluit in de brontekst staat.
ORGANISATIE_WORD = re.compile(r'^organisatienaam$', re.IGNORECASE)

#: Wat wij ervoor in de plaats zetten. Eén schrijfwijze, zichtbaar in Monday.
ORGANISATIE_TOKEN = '{organisatie}'

#: Regels die niet in een briefing horen. Dit is interne verkoopinstructie en zou
#: anders letterlijk bij de trainer op de deurmat vallen.
DROP_FROM = {
    'Kennismaken met AI': 'Let op! Extra vragen die je kan stellen tijdens een salesgesprek',
}

#: Zin die in de bron aan de vorige vastgeplakt zit doordat er vet in het midden staat.
UNGLUE = [
    ('Wat er niet aan bod komtIn onze training behandelen we twee zaken niet:',
     'Wat er niet aan bod komt. In onze training behandelen we twee zaken niet:'),
]

#: Een alinea eindigt een zin af als er een van deze tekens op staat.
SENTENCE_END = ('.', '?', '!', ':')

#: Een losse letter is een typefout die in de bron is blijven staan (`Kledingstijl en
#: kleurkeuze` heeft er een aan het eind). Geen inhoud, maar wel iets dat anders als
#: bullet in een briefing terechtkomt.
STRAY_LETTER = re.compile(r'^[A-Za-z]$')

#: De kortste échte regel is 25 tekens. Alles daaronder is opmaakresidu, en dat moet
#: hier stuklopen in plaats van bij de trainer op de deurmat vallen.
MIN_LINE = 20


def paragraph_text(node: ET.Element) -> str:
    return ''.join(t.text or '' for t in node.iter(W + 't'))


def is_heading(node: ET.Element) -> bool:
    """Een thema begint bij een `Kop1`-alinea met tekst.

    `Fail forward` staat in de bron als kop **met** lijstopmaak, midden in het
    pensioenthema. Op de stijlnaam toetsen in plaats van op de opmaak houdt hem erbij;
    daarom is het er 85 en niet 84.
    """
    props = node.find(W + 'pPr')
    if props is None:
        return False
    style = props.find(W + 'pStyle')
    if style is None:
        return False
    return (style.get(W + 'val') or '').startswith('Kop1') and paragraph_text(node).strip() != ''


def collapse_markers(lines: list[str]) -> list[str]:
    """Haalt de `xx`-markeringen weg en zet de plaatshouder terug op zijn plek."""
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if not MARKER.match(line):
            out.append(line)
            i += 1
            continue
        # Een paar markeringen met precies één alinea ertussen.
        if i + 2 < len(lines) and MARKER.match(lines[i + 2]):
            inner = lines[i + 1]
            out.append(ORGANISATIE_TOKEN if ORGANISATIE_WORD.match(inner) else inner)
            i += 3
            continue
        # Een losse markering midden in een zin is zelf de plaatshouder — tenzij het
        # woord er direct achter alsnog staat. Vier thema's schrijven `xx` /
        # `organisatienaam en binnen deze groep?`; daar is de markering alleen het
        # openingshaakje en zou hem meetellen `{organisatie} {organisatie}` opleveren.
        following = lines[i + 1] if i + 1 < len(lines) else ''
        if (out and not out[-1].rstrip().endswith(SENTENCE_END)
                and not ORGANISATIE_WORD.match(following.split(' ')[0])):
            out.append(ORGANISATIE_TOKEN)
            i += 1
            continue
        # Een losse markering aan het begin of eind van een bullet is opmaakresidu.
        i += 1
    return out


def join_broken(lines: list[str]) -> list[str]:
    """Plakt alinea's terug aan elkaar die midden in een zin zijn afgebroken."""
    out: list[str] = []
    for line in lines:
        if out and not out[-1].rstrip().endswith(SENTENCE_END):
            out[-1] = f'{out[-1].rstrip()} {line.lstrip()}'
        else:
            out.append(line)
    return out


def normalise(line: str) -> str:
    """Zet de overgebleven schrijfwijzen van de plaatshouder om, en ruimt witruimte op."""
    line = re.sub(r'\borganisatienaam\b', ORGANISATIE_TOKEN, line, flags=re.IGNORECASE)
    line = re.sub(r'(?<![A-Za-z0-9])[xX]{2,3}(?![A-Za-z0-9])', ORGANISATIE_TOKEN, line)
    for before, after in UNGLUE:
        line = line.replace(before, after)
    return re.sub(r'\s+', ' ', line).strip()


def extract(path: str) -> list[dict]:
    root = ET.fromstring(zipfile.ZipFile(path).read('word/document.xml'))
    body = root.find(W + 'body')
    if body is None:
        raise SystemExit('geen document-body gevonden')

    themes: list[dict] = []
    current: dict | None = None
    seen_first_heading = False
    for node in body.iter(W + 'p'):
        text = paragraph_text(node).strip()
        props = node.find(W + 'pPr')
        style = ''
        if props is not None:
            styled = props.find(W + 'pStyle')
            style = (styled.get(W + 'val') or '') if styled is not None else ''
        if style.startswith('Inhopg'):
            continue  # de inhoudsopgave
        if is_heading(node):
            seen_first_heading = True
            current = {'skelet': text, 'regels': []}
            themes.append(current)
            continue
        if not seen_first_heading or current is None or text == '':
            continue
        current['regels'].append(text)

    for theme in themes:
        lines = collapse_markers(theme['regels'])
        lines = join_broken(lines)
        lines = [normalise(x) for x in lines]
        drop = DROP_FROM.get(theme['skelet'])
        if drop is not None:
            cut = next((i for i, x in enumerate(lines) if x.startswith(drop)), None)
            if cut is None:
                raise SystemExit(f'{theme["skelet"]}: de te verwijderen regel "{drop}" staat er niet')
            lines = lines[:cut]
        theme['regels'] = [x for x in lines if x != '' and not STRAY_LETTER.match(x)]
    return themes


def main() -> None:
    docx, out = sys.argv[1], sys.argv[2]
    themes = extract(docx)
    if len(themes) != EXPECTED_THEMES:
        raise SystemExit(f'{len(themes)} thema\'s gevonden, verwacht {EXPECTED_THEMES}')
    empty = [t['skelet'] for t in themes if len(t['regels']) < 5]
    if empty:
        raise SystemExit(f'thema zonder inhoud: {empty}')
    leftover = [(t['skelet'], r) for t in themes for r in t['regels'] if MARKER.match(r)]
    if leftover:
        raise SystemExit(f'markering blijven staan: {leftover[:5]}')
    stubs = [(t['skelet'], r) for t in themes for r in t['regels'] if len(r) < MIN_LINE]
    if stubs:
        raise SystemExit(f'regels te kort om inhoud te zijn: {stubs[:5]}')
    doubled = [(t['skelet'], r) for t in themes for r in t['regels']
               if r.count(ORGANISATIE_TOKEN) > 1]
    if doubled:
        raise SystemExit(f'plaatshouder dubbel: {doubled[:5]}')
    with open(out, 'w', encoding='utf-8') as handle:
        json.dump(themes, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    afspraken = sum(1 for t in themes
                    if any(r.startswith('Welke afspraken') for r in t['regels']))
    org = sum(1 for t in themes if any(ORGANISATIE_TOKEN in r for r in t['regels']))
    print(f'  {len(themes)} thema\'s, {sum(len(t["regels"]) for t in themes)} regels')
    print(f'  {org} met {ORGANISATIE_TOKEN}, {afspraken} met de afsprakenbullet')
    print(f'  wrote {out}')


if __name__ == '__main__':
    main()

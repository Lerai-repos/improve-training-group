"""Geeft de achtergrondlus in de negen sjablonen een vette variant voor de kopjes.

ITG schrijft de achtergrond met vaste kopjes ("De aanleiding", "De deelnemersgroep", ...), en
Monday plakt die aan de zin erna. `lib/briefing/alineas.ts` haalt ze er weer los en markeert
ze; dit sjabloon zet ze dan vet (12-Oct-2026). De lus wordt:

    FOR a IN achtergrond
      IF $a.kop   -> dezelfde alinea, vet
      IF !$a.kop  -> dezelfde alinea, gewoon
    END-FOR a

Twee alinea's met elk een `IF`, en niet één die zich aanpast: `docx-templates` kan tekst
weglaten, maar geen opmaak omzetten — dezelfde reden als bij de drie regelvarianten van de
blokken (zie body.py).

Werkt op de BESTAANDE sjablonen, net als teksten.py en volgorde.py, op de ruwe XML: alles
buiten de lus blijft byte voor byte gelijk.

    python3 tools/briefing-templates/achtergrond-koppen.py

Slaat een sjabloon over dat al omgezet is.
"""

from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path

from teksten import LABELS, TEMPLATES, alineas, commando, eentje

OUD = "+++$a+++"
NIEUW = "+++$a.tekst+++"
GEDAAN = "+++IF $a.kop+++"
# Twee exemplaren van één alinea met hetzelfde paraId/textId zijn ongeldig voor Word.
IDS = re.compile(r'\s+w14:(?:paraId|textId)="[^"]*"')


def vet(alinea_xml: str) -> str:
    """Dezelfde alinea, met elke run vet. `w:b` hoort vooraan in `w:rPr`."""
    zonder_ids = IDS.sub("", alinea_xml)
    runs = re.sub(r"(<w:r(?:\s[^>]*)?>)<w:rPr>", r"\1<w:rPr><w:b/><w:bCs/>", zonder_ids)
    runs = re.sub(r"(<w:r(?:\s[^>]*)?>)(?!<w:rPr>)", r"\1<w:rPr><w:b/><w:bCs/></w:rPr>", runs)
    if "<w:b/>" not in runs:
        raise SystemExit("de achtergrondalinea heeft geen run om vet te maken")
    return runs


def zet_om(xml: str) -> str | None:
    if GEDAAN in xml:
        return None
    lijst = alineas(xml)
    regel = eentje(lijst, OUD, lambda a: a.tekst == OUD)
    if lijst[regel - 1].tekst != "+++FOR a IN achtergrond+++" or lijst[regel + 1].tekst != "+++END-FOR a+++":
        raise SystemExit("de achtergrondlus heeft niet de verwachte opbouw")
    gewoon = lijst[regel].xml
    if gewoon.count(OUD) != 1:
        raise SystemExit("verwacht +++$a+++ precies één keer in één run")
    gewoon = gewoon.replace(OUD, NIEUW)
    lus = "".join(
        [
            commando(GEDAAN),
            vet(gewoon),
            commando("+++END-IF+++"),
            commando("+++IF !$a.kop+++"),
            gewoon,
            commando("+++END-IF+++"),
        ]
    )
    return xml[: lijst[regel].start] + lus + xml[lijst[regel].end :]


def herschrijf(pad: Path) -> bool:
    with zipfile.ZipFile(pad) as bron:
        entries = [(info, bron.read(info.filename)) for info in bron.infolist()]
    uit = []
    veranderd = False
    for info, data in entries:
        if info.filename == "word/document.xml":
            nieuw = zet_om(data.decode("utf8"))
            if nieuw is not None:
                data = nieuw.encode("utf8")
                veranderd = True
        uit.append((info, data))
    if not veranderd:
        return False
    tijdelijk = pad.with_suffix(".tmp")
    with zipfile.ZipFile(tijdelijk, "w") as doel:
        for info, data in uit:
            doel.writestr(info, data, compress_type=info.compress_type)
    tijdelijk.replace(pad)
    return True


def main() -> int:
    for label in LABELS:
        pad = TEMPLATES / f"{label}.docx"
        print(f"{'omgezet' if herschrijf(pad) else 'al omgezet'}: {pad}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

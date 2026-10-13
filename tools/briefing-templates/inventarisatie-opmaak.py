"""Zet de inventarisatie in de negen sjablonen op zoals ITG's eigen voorbeeldbriefing.

In `2.0 ITG vb Briefing Probiblio` staat elke vraag vet, het antwoord eronder gewoon, en tussen
twee paren een witregel. De lus deed vraag en antwoord allebei gewoon en zonder witregel; dat
leest als één lap zodra de antwoorden binnenkomen (13-Oct-2026). De lus wordt:

    FOR v IN inventarisatie
      (lege alinea)
      $v.vraag     -> vet
      $v.antwoord
    END-FOR v

De witregel vóór de vraag, net als bij de blokken: dan staat er ook één tussen de inleiding en
de eerste vraag, en geen achter de laatste.

Werkt op de BESTAANDE sjablonen, op de ruwe XML, net als achtergrond-koppen.py.

    python3 tools/briefing-templates/inventarisatie-opmaak.py

Slaat een sjabloon over dat al omgezet is.
"""

from __future__ import annotations

import re
import sys
import zipfile
from importlib import import_module
from pathlib import Path

from teksten import LABELS, TEMPLATES, alineas, eentje

# Dezelfde vetmaker als voor de kopjes van de achtergrond; de bestandsnaam heeft een streepje.
vet = import_module("achtergrond-koppen").vet

VRAAG = "+++$v.vraag+++"
ANTWOORD = "+++$v.antwoord+++"
RUN = re.compile(r"<w:r(?:\s[^>]*)?>.*?</w:r>", re.S)


def leeg(alinea_xml: str) -> str:
    """Dezelfde alinea zonder tekst: een witregel in dezelfde opmaak."""
    zonder = RUN.sub("", alinea_xml)
    return re.sub(r'\s+w14:(?:paraId|textId)="[^"]*"', "", zonder)


def zet_om(xml: str) -> str | None:
    lijst = alineas(xml)
    vraag = eentje(lijst, VRAAG, lambda a: a.tekst == VRAAG)
    if "<w:b/>" in lijst[vraag].xml:
        return None
    if lijst[vraag - 1].tekst != "+++FOR v IN inventarisatie+++" or lijst[vraag + 1].tekst != ANTWOORD:
        raise SystemExit("de inventarisatielus heeft niet de verwachte opbouw")
    nieuw = leeg(lijst[vraag + 1].xml) + vet(lijst[vraag].xml)
    return xml[: lijst[vraag].start] + nieuw + xml[lijst[vraag].end :]


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

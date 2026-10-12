"""Zet in de negen sjablonen de rolblokken ONDER `Concept inhoud`, vlak boven de overige blokken.

Dirkje, 12-Oct-2026: eerst het concept programma, dan de teksten voor de rol, de groep, vaste
klant, cyclus en opdrachten. Dat draait Tims keuze van 24-Aug-2026 om ("so the page starts
with that"). De volgorde wordt dus:

    Concept inhoud (kop, inleiding, bullets) -> rolblokken -> overige blokken -> Inventarisatie

Werkt op de BESTAANDE sjablonen, net als teksten.py: die zijn met de hand bijgewerkt en zouden
bij opnieuw genereren hun grijze labelcellen en links uitgelijnde tabel verliezen. Verplaatst
alleen de alinea's van de rolblokkenlus, byte voor byte; de witregel brengt elk blok zelf mee,
vóór zijn titel, dus de afstand blijft overal één witregel.

    python3 tools/briefing-templates/volgorde.py

Slaat een sjabloon over dat al omgezet is, dus twee keer draaien is onschuldig.
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

from teksten import LABELS, TEMPLATES, alineas, eentje

ROL_BEGIN = "+++FOR blk IN rolblokken+++"
EINDE = "+++END-FOR blk+++"
OVERIGE_BEGIN = "+++FOR blk IN blokken+++"


def verplaats(xml: str) -> str | None:
    """De rolblokkenlus vlak vóór de overige blokken; `None` als hij daar al staat."""
    lijst = alineas(xml)
    rol = eentje(lijst, ROL_BEGIN, lambda a: a.tekst == ROL_BEGIN)
    overige = eentje(lijst, OVERIGE_BEGIN, lambda a: a.tekst == OVERIGE_BEGIN)
    einde = next((i for i in range(rol + 1, len(lijst)) if lijst[i].tekst == EINDE), None)
    if einde is None:
        raise SystemExit("de rolblokkenlus heeft geen END-FOR blk")
    if einde + 1 == overige:
        return None
    if overige < rol:
        raise SystemExit("de overige blokken staan vóór de rolblokken; onverwachte opbouw")
    concept = eentje(lijst, "FOR s IN concept", lambda a: a.tekst == "+++FOR s IN concept+++")
    if not rol < concept < overige:
        raise SystemExit("Concept inhoud staat niet tussen de rolblokken en de overige blokken")
    lus = xml[lijst[rol].start : lijst[einde].end]
    zonder = xml[: lijst[rol].start] + xml[lijst[einde].end :]
    plek = lijst[overige].start - len(lus)
    return zonder[:plek] + lus + zonder[plek:]


def herschrijf(pad: Path) -> bool:
    """Zet één sjabloon om; `False` als het al goed stond."""
    with zipfile.ZipFile(pad) as bron:
        entries = [(info, bron.read(info.filename)) for info in bron.infolist()]
    uit = []
    veranderd = False
    for info, data in entries:
        if info.filename == "word/document.xml":
            nieuw = verplaats(data.decode("utf8"))
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
        print(f"{'omgezet' if herschrijf(pad) else 'stond al goed'}: {pad}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

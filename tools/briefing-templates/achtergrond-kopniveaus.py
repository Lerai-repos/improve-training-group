"""Geeft de vette achtergrondkopjes in de sjablonen drie groottes, naar hun titelsoort.

Sinds 29-Oct-2026 komt de achtergrond uit een Monday-document, met grote, middelgrote en kleine
titels. `lib/briefing/compose.ts` geeft elke alinea een `niveau` (1, 2, 3; 0 is geen kopje). De
ene vette variant die `achtergrond-koppen.py` maakte wordt er drie:

    IF $a.niveau === 1  -> vet, 13,5 pt
    IF $a.niveau === 2  -> vet, 13 pt
    IF $a.niveau === 3  -> vet, gewone grootte (12,5 pt uit de stijl Standaard)
    IF !$a.kop          -> ongewijzigd

Alle drie onder de 14 pt van de sectiekoppen (`Kop1`, zoals "Concept inhoud"), zodat een kopje in
de achtergrond niet als een nieuwe sectie leest.

Werkt op de BESTAANDE sjablonen, op de ruwe XML, net als achtergrond-koppen.py: alles buiten die
ene vette alinea blijft byte voor byte gelijk. Draai eerst achtergrond-koppen.py.

    python3 tools/briefing-templates/achtergrond-kopniveaus.py

Slaat een sjabloon over dat al omgezet is.
"""

from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path

from teksten import LABELS, TEMPLATES, alineas, commando, eentje

OUD = "+++IF $a.kop+++"
GEDAAN = "+++IF $a.niveau === 1+++"
# Twee exemplaren van één alinea met hetzelfde paraId/textId zijn ongeldig voor Word.
IDS = re.compile(r'\s+w14:(?:paraId|textId)="[^"]*"')
# Halve punten, zoals Word ze opslaat.
GROOTTES = {1: 27, 2: 26}
# Wat in `w:rPr` ná `w:sz`/`w:szCs` hoort (ECMA-376); de grootte moet daarvóór.
NA_GROOTTE = (
    "w:highlight", "w:u", "w:effect", "w:bdr", "w:shd", "w:fitText", "w:vertAlign",
    "w:rtl", "w:cs", "w:em", "w:lang", "w:eastAsianLayout", "w:specVanish", "w:oMath",
)
RUN_RPR = re.compile(r"(<w:r(?:\s[^>]*)?>)<w:rPr>(.*?)</w:rPr>", re.S)


def met_grootte(alinea_xml: str, halve_punten: int) -> str:
    """Dezelfde alinea, met een vaste grootte op elke run die tekst draagt."""
    grootte = f'<w:sz w:val="{halve_punten}"/><w:szCs w:val="{halve_punten}"/>'

    def zet(m: re.Match[str]) -> str:
        rpr = m.group(2)
        if "<w:sz " in rpr:
            raise SystemExit("de vette achtergrondalinea heeft al een grootte; onverwacht")
        posities = [rpr.find(f"<{naam}") for naam in NA_GROOTTE]
        posities = [p for p in posities if p >= 0]
        at = min(posities) if posities else len(rpr)
        return f"{m.group(1)}<w:rPr>{rpr[:at]}{grootte}{rpr[at:]}</w:rPr>"

    nieuw, aantal = RUN_RPR.subn(zet, IDS.sub("", alinea_xml))
    if aantal == 0:
        raise SystemExit("de vette achtergrondalinea heeft geen run met opmaak")
    return nieuw


def zet_om(xml: str) -> str | None:
    if GEDAAN in xml:
        return None
    lijst = alineas(xml)
    regel = eentje(lijst, OUD, lambda a: a.tekst == OUD)
    vet, einde = lijst[regel + 1], lijst[regel + 2]
    if "+++$a.tekst+++" not in vet.tekst or einde.tekst != "+++END-IF+++":
        raise SystemExit("de vette achtergrondvariant heeft niet de verwachte opbouw")
    if "<w:b/>" not in vet.xml:
        raise SystemExit("de vette achtergrondvariant is niet vet; draai eerst achtergrond-koppen.py")
    varianten = "".join(
        [
            commando(GEDAAN),
            met_grootte(vet.xml, GROOTTES[1]),
            commando("+++END-IF+++"),
            commando("+++IF $a.niveau === 2+++"),
            met_grootte(vet.xml, GROOTTES[2]),
            commando("+++END-IF+++"),
            commando("+++IF $a.niveau === 3+++"),
            vet.xml,
            commando("+++END-IF+++"),
        ]
    )
    return xml[: lijst[regel].start] + varianten + xml[einde.end :]


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
    # De negen labelsjablonen en het algemene sjabloon (voor labels zonder eigen sjabloon).
    for naam in [*LABELS, "_algemeen"]:
        pad = TEMPLATES / f"{naam}.docx"
        print(f"{'omgezet' if herschrijf(pad) else 'al omgezet'}: {pad}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

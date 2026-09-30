"""Zet de vaste teksten in de negen sjablonen om naar lussen over het bord Briefingteksten.

Sinds 30-Sep-2026 beheert ITG elke tekst in de briefing zelf, op een Monday-bord. De teksten
die tot dan toe letterlijk in de sjablonen stonden worden hier vervangen door `FOR`-lussen,
zodat de code bepaalt wát er staat en het sjabloon alleen nog zegt wáár en hoe het eruitziet:

- de algemene tekst onder `Algemeen.` (inleiding, vier kopjes, afsluiting) -> `algemeen`
- de cyaan Monday Challenges-regel boven de tabel                          -> `mondayChallenges`
- kop + inleiding van `Concept inhoud`                                      -> `concept`
- kop + inleiding van `Inventarisatie klant`                                -> `inventarisatieIntro`
- de zin "Het inventarisatieformulier is (nog) niet ingevuld ..."           -> `inventarisatieLeeg`
- de bloktitels komen achter een `IF`: ITG mag een kop leegmaken

Werkt op de BESTAANDE sjablonen in lib/briefing/templates, niet op ITG's .dotx: de grijze
labelcellen en de links uitgelijnde tabel (22-Sep-2026) zijn met de hand in die bestanden
gezet en zouden bij opnieuw genereren verdwijnen.

    python3 tools/briefing-templates/teksten.py

Weigert een sjabloon dat al is omgezet, dus twee keer draaien is onschuldig.

Bewust op de ruwe XML en niet via ElementTree: alles buiten de vervangen alinea's blijft zo
byte voor byte gelijk, en de tien namespaces uit `mc:Ignorable` (zie xmlkeep.py) kunnen niet
verloren gaan.
"""

from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path

TEMPLATES = Path("lib/briefing/templates")
LABELS = ("CC", "CP", "FT", "FV", "IT", "JE", "SST", "TT", "WJ")
MARKER = "+++FOR s IN algemeen+++"

# De ruimte onder de kopband `Algemeen.`: de eigen V-offset van het tekstvak waar de inleiding
# ooit in stond (zie README). Stond op de eerste alinea van de inleiding; die kan ITG nu
# leegmaken, dus draagt een eigen, vrijwel onzichtbare alinea hem.
SPACER = (
    '<w:p><w:pPr><w:spacing w:before="1077" w:after="0" w:line="20" w:lineRule="exact"/>'
    '<w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>'
)

TAG = re.compile(r"<(/?)w:p(?=[\s>/])([^>]*)>")
TEXT = re.compile(r"<w:t(?:\s[^>]*)?>([^<]*)</w:t>")


class Alinea:
    def __init__(self, start: int, end: int, xml: str) -> None:
        self.start = start
        self.end = end
        self.xml = xml[start:end]
        self.tekst = "".join(TEXT.findall(self.xml))


def alineas(xml: str) -> list[Alinea]:
    """Elke alinea die niet in een andere alinea zit (dus niet in een tekstvak)."""
    uit: list[Alinea] = []
    diepte = 0
    begin = -1
    for m in TAG.finditer(xml):
        sluit, attrs = m.group(1) == "/", m.group(2)
        if attrs.endswith("/"):
            if diepte == 0:
                uit.append(Alinea(m.start(), m.end(), xml))
            continue
        if sluit:
            diepte -= 1
            if diepte == 0:
                uit.append(Alinea(begin, m.end(), xml))
        else:
            if diepte == 0:
                begin = m.start()
            diepte += 1
    if diepte != 0:
        raise SystemExit("alinea's niet in balans; sjabloon onleesbaar")
    return uit


def eentje(lijst: list[Alinea], wat: str, test) -> int:
    treffers = [i for i, a in enumerate(lijst) if test(a)]
    if len(treffers) != 1:
        raise SystemExit(f"verwacht precies één alinea '{wat}', gevonden: {len(treffers)}")
    return treffers[0]


def commando(cmd: str) -> str:
    """Een alinea met alleen een commando; `docx-templates` haalt die bij het renderen weg."""
    cmd = cmd.replace("&", "&amp;")
    return f'<w:p><w:r><w:t xml:space="preserve">{cmd}</w:t></w:r></w:p>'


def vervang_tekst(alinea_xml: str, oud: str, nieuw: str) -> str:
    if alinea_xml.count(oud) != 1:
        raise SystemExit(f"verwacht {oud} precies één keer in de alinea")
    return alinea_xml.replace(oud, nieuw)


def sectielus(lijst_naam: str, bouwstenen: dict[str, str]) -> str:
    """De lus over een lijst `DocumentSectie`s: witregel, kop, en de regels in drie varianten."""
    return "".join(
        [
            commando(f"+++FOR s IN {lijst_naam}+++"),
            commando("+++IF $s.witregel+++"),
            bouwstenen["leeg"],
            commando("+++END-IF+++"),
            commando("+++IF $s.kop+++"),
            vervang_tekst(bouwstenen["kop"], "+++$blk.titel+++", "+++$s.kop+++"),
            commando("+++END-IF+++"),
            commando("+++FOR r IN $s.regels+++"),
            commando("+++IF $r.bullet && !$r.niveau+++"),
            bouwstenen["niveau0"],
            commando("+++END-IF+++"),
            commando("+++IF $r.bullet && $r.niveau+++"),
            bouwstenen["niveau1"],
            commando("+++END-IF+++"),
            commando("+++IF !$r.bullet+++"),
            bouwstenen["alinea"],
            commando("+++END-IF+++"),
            commando("+++END-FOR r+++"),
            commando("+++END-FOR s+++"),
        ]
    )


def bouwstenen_uit(lijst: list[Alinea]) -> dict[str, str]:
    """De opmaak van de bestaande blokkenlus: die hoort de algemene tekst ook te krijgen."""
    lus = eentje(lijst, "FOR blk IN rolblokken", lambda a: a.tekst == "+++FOR blk IN rolblokken+++")
    leeg, kop = lijst[lus + 1], lijst[lus + 2]
    if leeg.tekst != "" or kop.tekst != "+++$blk.titel+++":
        raise SystemExit("de rolblokkenlus begint niet met een witregel en de bloktitel")
    varianten = [a for a in lijst[lus : lus + 20] if a.tekst == "+++$r.tekst+++"][:3]
    if len(varianten) != 3:
        raise SystemExit("de drie regelvarianten van de rolblokkenlus niet gevonden")
    niveaus = [re.search(r'<w:ilvl w:val="(\d)"', v.xml) for v in varianten]
    soort = ["0" if n and n.group(1) == "0" else "1" if n else "alinea" for n in niveaus]
    if soort != ["0", "1", "alinea"]:
        raise SystemExit(f"regelvarianten in onverwachte volgorde: {soort}")
    return {
        "leeg": leeg.xml,
        "kop": kop.xml,
        "niveau0": varianten[0].xml,
        "niveau1": varianten[1].xml,
        "alinea": varianten[2].xml,
    }


def verboden(stuk: str) -> None:
    """Een vervangen stuk mag geen anker, tekstvak of sectie-einde meenemen."""
    for teken in ("txbxContent", "<w:drawing", "mc:AlternateContent", "<w:sectPr", 'w:type="page"'):
        if teken in stuk:
            raise SystemExit(f"te vervangen stuk bevat {teken}; zou de opmaak breken")


def zet_om(xml: str) -> str:
    lijst = alineas(xml)
    stenen = bouwstenen_uit(lijst)
    vervangingen: list[tuple[int, int, str]] = []

    # 1. De algemene tekst: van de inleiding tot en met "Vragen? We horen het graag!".
    van = eentje(lijst, "inleiding", lambda a: a.tekst.startswith("Binnenkort organiseer je namens"))
    tot = eentje(lijst, "afsluiting", lambda a: a.tekst.strip() == "Vragen? We horen het graag!")
    teksten = [a.tekst.strip() for a in lijst[van : tot + 1] if a.tekst.strip() != ""]
    if len(teksten) != 10:
        raise SystemExit(f"algemene tekst heeft {len(teksten)} alinea's met tekst, verwacht 10")
    stuk = xml[lijst[van].start : lijst[tot].end]
    verboden(stuk)
    vervangingen.append((lijst[van].start, lijst[tot].end, SPACER + sectielus("algemeen", stenen)))

    # 2. De cyaan regel boven de tabel.
    mc = eentje(lijst, "Monday Challenges", lambda a: "niet aan te bieden in je sessie" in a.tekst)
    oud = lijst[mc].xml
    ppr = re.search(r"<w:pPr>.*?</w:pPr>", oud, re.S)
    # De opmaak van de eerste run MET tekst: FT begint met een lege run zonder markering.
    runs = re.findall(r"<w:r(?:\s[^>/]*)?>(.*?)</w:r>", oud, re.S)
    rpr = next(
        (m for r in runs if "<w:t" in r for m in [re.search(r"(<w:rPr>.*?</w:rPr>)", r, re.S)]),
        None,
    )
    if ppr is None or rpr is None or 'w:val="cyan"' not in rpr.group(1):
        raise SystemExit("de Monday Challenges-regel heeft niet de verwachte cyaan opmaak")
    regel = (
        f"<w:p>{ppr.group(0)}<w:r>{rpr.group(1)}"
        '<w:t xml:space="preserve">+++$m+++</w:t></w:r></w:p>'
    )
    verboden(oud)
    vervangingen.append(
        (
            lijst[mc].start,
            lijst[mc].end,
            commando("+++FOR m IN mondayChallenges+++") + regel + commando("+++END-FOR m+++"),
        )
    )

    # 3. Concept inhoud: witregel, kop en inleiding.
    kop = eentje(lijst, "Concept inhoud", lambda a: a.tekst == "Concept inhoud")
    intro = kop + 1
    if lijst[kop - 1].tekst != "" or not lijst[intro].tekst.startswith("Het volgende concept"):
        raise SystemExit("Concept inhoud heeft niet de verwachte witregel/kop/inleiding")
    vervangingen.append((lijst[kop - 1].start, lijst[intro].end, sectielus("concept", stenen)))

    # 4. Inventarisatie klant: witregel, kop en inleiding.
    kop = eentje(lijst, "Inventarisatie klant", lambda a: a.tekst == "Inventarisatie klant")
    intro = kop + 1
    if lijst[kop - 1].tekst != "" or not lijst[intro].tekst.startswith("Onderstaande informatie"):
        raise SystemExit("Inventarisatie klant heeft niet de verwachte witregel/kop/inleiding")
    vervangingen.append(
        (lijst[kop - 1].start, lijst[intro].end, sectielus("inventarisatieIntro", stenen))
    )

    # 5. De zin voor een niet ingevuld formulier.
    leeg = eentje(lijst, "formulier leeg", lambda a: a.tekst.startswith("Het inventarisatieformulier is"))
    vervangingen.append(
        (lijst[leeg].start, lijst[leeg].end, sectielus("inventarisatieLeeg", stenen))
    )

    # 6. Elke bloktitel achter een IF, zodat een lege kop geen lege kopregel achterlaat.
    titels = [a for a in lijst if a.tekst == "+++$blk.titel+++"]
    if len(titels) != 2:
        raise SystemExit(f"verwacht twee bloktitels, gevonden: {len(titels)}")
    for titel in titels:
        vervangingen.append(
            (
                titel.start,
                titel.end,
                commando("+++IF $blk.titel+++") + titel.xml + commando("+++END-IF+++"),
            )
        )

    # Van achter naar voren, zodat de posities van de eerdere vervangingen blijven kloppen.
    vervangingen.sort(key=lambda v: v[0], reverse=True)
    for i in range(len(vervangingen) - 1):
        if vervangingen[i + 1][1] > vervangingen[i][0]:
            raise SystemExit("vervangingen overlappen")
    for start, end, nieuw in vervangingen:
        xml = xml[:start] + nieuw + xml[end:]
    return xml


def herschrijf(pad: Path) -> bool:
    """Zet één sjabloon om; `False` als het al omgezet was."""
    with zipfile.ZipFile(pad) as bron:
        entries = [(info, bron.read(info.filename)) for info in bron.infolist()]
        if MARKER in bron.read("word/document.xml").decode("utf8"):
            return False
    uit = []
    for info, data in entries:
        if info.filename == "word/document.xml":
            data = zet_om(data.decode("utf8")).encode("utf8")
        uit.append((info, data))
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

"""Maak het algemene sjabloon voor een label zonder eigen sjabloon: `_algemeen.docx`.

Sinds 13-Oct-2026 voegt ITG zelf labels toe op het Labels-bord (Peter: één label `ITG` voor
dertien testsites). De negen bestaande sjablonen verschillen onderling alleen in twee
afbeeldingen, het logo op het voorblad en het logo in de voettekst, en in het woord in de
gegevenstabel ("Training", "Workshop", "Teambuilding"). Al het andere is gelijk: dezelfde foto's,
dezelfde opbouw, dezelfde lussen.

Dit script kopieert `IT.docx` en maakt die drie verschillen invulbaar:

- de twee logo's krijgen de relatie-id `rIdLabelLogo` en een leeg plaatje van 1x1 pixel; de
  code zet er bij het renderen het logo van het Labels-bord in (`lib/briefing/logo.ts`). Een
  mislukte vervanging toont zo nooit het logo van Incompany Trainer.
- het woord in de gegevenstabel wordt `+++term+++`, de Term van het Labels-bord.

    python3 tools/briefing-templates/algemeen.py

Overschrijft `_algemeen.docx` elke keer opnieuw vanuit `IT.docx`. Draai dit dus NA een script
dat alle sjablonen omzet, anders mist het algemene sjabloon die omzetting. Het underscore-
voorvoegsel houdt het buiten de labelnamen: een label heet nooit `_ALGEMEEN`.
"""

from __future__ import annotations

import base64
import re
import sys
import zipfile
from pathlib import Path

from teksten import TEMPLATES, alineas, eentje, vervang_tekst

BRON = TEMPLATES / "IT.docx"
DOEL = TEMPLATES / "_algemeen.docx"

LOGO_ID = "rIdLabelLogo"
# Een doorzichtige PNG van 1x1 pixel.
LEEG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)

# Per onderdeel: de relatie-id van het logo in IT.docx en de nieuwe naam van het plaatje.
LOGOS = {
    "word/document.xml": ("rId10", "media/image1.png", "media/labellogo1.png"),
    "word/footer1.xml": ("rId1", "media/image5.png", "media/labellogo2.png"),
}


def rels_van(onderdeel: str) -> str:
    map_, naam = onderdeel.rsplit("/", 1)
    return f"{map_}/_rels/{naam}.rels"


def precies_een(tekst: str, oud: str, nieuw: str, waar: str) -> str:
    if tekst.count(oud) != 1:
        raise SystemExit(f"{waar}: verwacht {oud} precies één keer, gevonden {tekst.count(oud)}")
    return tekst.replace(oud, nieuw)


def term_invulbaar(xml: str) -> str:
    """Het woord "Training" in de gegevenstabel, direct onder de rij van de opdrachtgever."""
    lijst = alineas(xml)
    i = eentje(lijst, "Training", lambda a: a.tekst == "Training")
    if lijst[i - 1].tekst != "+++opdrachtgever+++":
        raise SystemExit("de gegevenstabel heeft niet de verwachte opbouw")
    nieuw = vervang_tekst(lijst[i].xml, ">Training</w:t>", ">+++term+++</w:t>")
    return xml[: lijst[i].start] + nieuw + xml[lijst[i].end :]


def main() -> int:
    with zipfile.ZipFile(BRON) as bron:
        entries = [(info, bron.read(info.filename)) for info in bron.infolist()]
    inhoud = {info.filename: data for info, data in entries}

    nieuw: dict[str, bytes] = {}
    weg: set[str] = set()
    for onderdeel, (rid, oud, naar) in LOGOS.items():
        xml = inhoud[onderdeel].decode("utf8")
        xml = precies_een(xml, f'r:embed="{rid}"', f'r:embed="{LOGO_ID}"', onderdeel)
        if onderdeel == "word/document.xml":
            xml = term_invulbaar(xml)
        nieuw[onderdeel] = xml.encode("utf8")

        rels_pad = rels_van(onderdeel)
        rels = inhoud[rels_pad].decode("utf8")
        relatie = re.search(rf'<Relationship [^>]*Id="{rid}"[^>]*/>', rels)
        if relatie is None or f'Target="{oud}"' not in relatie.group(0):
            raise SystemExit(f"{rels_pad}: {rid} wijst niet naar {oud}")
        vervangen = relatie.group(0).replace(f'Id="{rid}"', f'Id="{LOGO_ID}"').replace(
            f'Target="{oud}"', f'Target="{naar}"'
        )
        nieuw[rels_pad] = rels.replace(relatie.group(0), vervangen).encode("utf8")
        weg.add(f"word/{oud}")
        nieuw[f"word/{naar}"] = LEEG

    tijdelijk = DOEL.with_suffix(".tmp")
    with zipfile.ZipFile(tijdelijk, "w") as doel:
        for info, data in entries:
            if info.filename in weg:
                continue
            doel.writestr(info, nieuw.pop(info.filename, data), compress_type=info.compress_type)
        for naam, data in nieuw.items():
            doel.writestr(naam, data, compress_type=zipfile.ZIP_DEFLATED)
    tijdelijk.replace(DOEL)
    print(f"geschreven: {DOEL}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

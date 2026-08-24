"""Check that the block texts in lib/briefing/blocks.ts are still ITG's own words.

The block library is a closed list: whatever ITG supplied, we ship verbatim. That makes the
strings in blocks.ts a copy of a document we do not own, and a copy has no way of noticing
when it drifts. A rename sweep once rewrote 'huiswerkopdracht' to 'homework' inside those
strings, which typecheck, lint and every unit test happily accepted.

Run it whenever blocks.ts changes:

    python3 tools/briefing-templates/verify-blocks.py

Two checks, and both are needed:

1. **Nothing altered.** Every long literal in blocks.ts must appear verbatim in the source.
2. **Nothing missing.** Every paragraph in MANIFEST must still be present in blocks.ts.

Check 1 alone is useless against deletion: dropping a paragraph, or writing it in a syntax the
extractor does not recognise, simply lowers the total and still reports success. An earlier
version of this tool did exactly that, silently going from 13/13 to 9/9 when four paragraphs
moved from an array into named constants.

Needs ITG's source document, which lives in the gitignored docs/ tree, so this is a local
check and not a CI gate.
"""

from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

SOURCE = Path(
    "docs/Improve Training Group/Shared/Briefing bestanden/"
    "ITG Briefingteksten bij bijzonderheden.docx"
)
BLOCKS = Path("lib/briefing/blocks.ts")

# Onder deze lengte is een literal een label of een foutmelding, geen blokalinea.
#
# Stond op 60, en dat liet een gat: de rolblokken bestaan voor de helft uit kórte regels
# ("Ontwikkelen van training", "Het tot leven brengen van de praktijk"). Die werden niet eens
# uitgelezen, dus een stille wijziging erin bleef 24/24 melden — precies de faalwijze waar
# deze tool tegen is gebouwd, één laag dieper. Gemeten met een opzettelijke wijziging.
#
# Lager kan zonder ruis, want alleen alinea's die aan een MANIFEST-prefix voldoen worden
# vergeleken; de rest komt nergens terecht.
MIN_PARAGRAPH = 20

# Every paragraph blocks.ts is supposed to ship, by its opening words. Adding a block to the
# library means adding a line here; that is the point, because it makes a deletion loud.
MANIFEST = (
    "Elke trainer traint een eigen groep.",
    "Jullie trainen samen de gehele groep,",
    "Voor deze klant hebben we meerdere sessies",
    "Deze opdracht betreft een trainingscyclus",
    "Vóór de eerste sessie ontvangen deelnemers",
    "Aan het einde van elke sessie, of tijdens de laatste sessie",
    "Grofweg zie de cyclus ziet er als onderstaand uit.",
    "In overeenstemming met de klant verzorgen wij een huiswerkopdracht",
    "De opdracht dient deelnemers te helpen",
    "Zorg er zo veel mogelijk voor dat de opdracht",
    "Is de huiswerkopdracht niet onderdeel van een trainingscyclus",
    "Voor deze opdracht werken we met een voorbereidende opdracht,",
    "Ook kunnen de antwoorden inzicht geven",
    "In de bijlage van de mail vind je een template met voorbeeldvragen.",
    # De vier rolafhankelijke blokken. ITG's plaatshouder "Naam (tel nr)" staat bewust in de
    # literal, zodat juist deze zinnen letterlijk vergeleken kunnen worden.
    "Naast jou zijn er ook andere trainers ingedeeld op deze opdracht: Naam (tel nr), Naam (tel nr). Jij bent de leadtrainer",
    "Naast jou zijn er ook andere trainers ingedeeld op deze opdracht: Naam (tel nr), Naam (tel nr). Jij bent ingedeeld als co-trainer",
    "Afstemmen met de co-trainer(s) Alle trainers (jij en de co-trainers)",
    "Afstemmen met de co-trainer(s) Alle trainers (jij en de lead trainer)",
    "Voor deze opdracht werk je met een trainingsacteur:",
    "Voor deze opdracht word je ingezet als trainingsacteur,",
    "Belangrijk: de trainingsacteur is geen co-trainer of inhoudsdeskundige,",
    "Afstemmen met de trainingsacteur en evt. co-trainer(s)",
    "De aansturing van de inzet van de acteur,",
    "Het afstemmen van zijn/haar spel op het niveau van de deelnemer",
    # De korte regels uit dezelfde blokken. Kort maakt ze niet minder ITG's woorden.
    "Klantcontact vooraf via Teams/telefonisch",
    "Ontwikkelen van training",
    "Ontwikkelen van inhoud van de training",
    "De terugkoppeling en nabespreking met de klant en mij",
    "Als je wilt, kun je alvast contact opnemen met de leadtrainer.",
    "De (lead) trainer is verantwoordelijk voor",
    "De trainingsacteur is verantwoordelijk het",
    "De trainingsacteur is verantwoordelijk voor",
    "Het tot leven brengen van de praktijk",
    "Geven van feedback vanuit de rol",
    "Het geven van feedback vanuit de rol",
)

#: Afwijkingen van de brontekst die we BEWUST maken, met de reden erbij.
#:
#: Zonder dit zou een voorgeschreven correctie hetzelfde eruitzien als de stille drift waar
#: deze tool voor bestaat: allebei een regel die niet in het bronbestand staat. Hiermee is de
#: afwijking vastgelegd, blijft de rest van de zin bewaakt, en valt het op zodra ITG het zelf
#: repareert — want dan vindt de correctie niets meer om te vervangen.
CORRECTIONS = {
    "Kantcontact": (
        "Klantcontact",
        "typefout in ITG's bron; 06-briefing.md: 'Neem ze niet over ... gebruik de correcte "
        "spelling'",
    ),
    "trainingscacteur": (
        "trainingsacteur",
        "typefout in ITG's bron; zelfde instructie in 06-briefing.md",
    ),
}


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def unescape_ts(text: str) -> str:
    """De escapes van een TypeScript-literal terug naar de tekens die ze voorstellen.

    Zonder dit blijft `\\n` in blocks.ts twee tekens — backslash en n — die `squash` niet
    als witruimte ziet. De literal zou dan nooit overeenkomen met de bronalinea, en een
    correcte regelafbreking werd als afwijking gemeld.
    """
    return text.replace("\\n", "\n").replace("\\'", "'").replace("\\\\", "\\")


def source_paragraphs(path: Path) -> set[str]:
    """Elke alinea van ITG's bron, met haar regelafbrekingen als witruimte.

    Een `<w:br/>` MOET meetellen. Sloegen we hem over, dan las deze tool
    "co-trainer(s)Alle trainers" als de bedoelde tekst, en dan is de aan elkaar geplakte
    versie in blocks.ts precies wat de verificatie goedkeurt. Zo is die fout er ook in
    gekomen: de tekst was verbatim volgens deze tool, en las in Word als een fout.
    """
    root = ET.fromstring(zipfile.ZipFile(path).read("word/document.xml"))
    found = set()
    for par in root.iter(W + "p"):
        stuk = []
        for node in par.iter():
            if node.tag == W + "t":
                stuk.append(node.text or "")
            elif node.tag == W + "br":
                stuk.append("\n")
        text = squash("".join(stuk))
        if text:
            found.add(text)
    return found


def apply_corrections(paragraphs: set[str]) -> tuple[set[str], list[str]]:
    """The source text as we deliberately ship it, plus any correction that no longer applies.

    A stale correction matters: once ITG fixes the typo in their own document, ours silently
    becomes a divergence nobody chose. So it is reported rather than quietly ignored.
    """
    corrected = set(paragraphs)
    stale = []
    for wrong, (right, reason) in CORRECTIONS.items():
        hits = [p for p in paragraphs if wrong in p]
        if not hits:
            stale.append(f"{wrong!r} -> {right!r} ({reason})")
            continue
        for paragraph in hits:
            corrected.add(paragraph.replace(wrong, right))
    return corrected, stale


def strip_comments(code: str) -> str:
    """Remove comments before looking for string literals.

    Dutch prose is full of apostrophes — alinea's, Monday's, blok's — and to a regex those
    are indistinguishable from the quotes around a string. Leaving comments in makes the
    extractor pair a comment apostrophe with a later quote and swallow whole paragraphs of
    prose, which then show up as spurious mismatches while real ones hide behind them.
    """
    code = re.sub(r"/\*.*?\*/", "", code, flags=re.S)
    return re.sub(r"^\s*//.*$", "", code, flags=re.M)


def code_paragraphs(path: Path) -> list[str]:
    """Every long literal, however the expression happens to be terminated.

    Deliberately not anchored on a trailing comma: array entries end in ',', a named constant
    ends in ';', and an argument ends in ')'. Anchoring on one of them is how the earlier
    version stopped seeing four paragraphs without saying so.
    """
    code = strip_comments(path.read_text(encoding="utf8"))
    out = []
    for match in re.finditer(r"((?:'(?:[^'\\]|\\.)*'\s*\+\s*)*'(?:[^'\\]|\\.)*')", code):
        joined = squash(unescape_ts("".join(re.findall(r"'((?:[^'\\]|\\.)*)'", match.group(1)))))
        if len(joined) >= MIN_PARAGRAPH:
            out.append(joined)
    return out


def main() -> int:
    if not SOURCE.exists():
        print(f"source document not found: {SOURCE}")
        return 2

    expected, stale = apply_corrections(source_paragraphs(SOURCE))
    shipped = code_paragraphs(BLOCKS)

    for line in stale:
        print("STALE CORRECTION (ITG lijkt het zelf te hebben gerepareerd):", line)

    # The manifest drives the check. Literals that are not block paragraphs — error messages,
    # open-issue text — are ours to word and are deliberately not compared.
    missing, altered = [], []
    for prefix in MANIFEST:
        found = [p for p in shipped if p.startswith(prefix)]
        if not found:
            missing.append(prefix)
        else:
            altered.extend(p for p in found if p not in expected)

    for prefix in missing:
        print("MISSING:", prefix)
    for paragraph in altered:
        print("ALTERED:", paragraph[:150])

    ok = len(MANIFEST) - len(missing) - len(altered)
    if stale:
        return 1
    print(f"{ok}/{len(MANIFEST)} block paragraphs verbatim from {SOURCE.name}")
    return 1 if altered or missing else 0


if __name__ == "__main__":
    sys.exit(main())

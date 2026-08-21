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

# Below this length a literal is a label or an error message, not a block paragraph.
MIN_PARAGRAPH = 60

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
)


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def source_paragraphs(path: Path) -> set[str]:
    root = ET.fromstring(zipfile.ZipFile(path).read("word/document.xml"))
    found = set()
    for par in root.iter(W + "p"):
        text = squash("".join(node.text or "" for node in par.iter(W + "t")))
        if text:
            found.add(text)
    return found


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
        joined = squash("".join(re.findall(r"'((?:[^'\\]|\\.)*)'", match.group(1))))
        if len(joined) >= MIN_PARAGRAPH:
            out.append(joined)
    return out


def main() -> int:
    if not SOURCE.exists():
        print(f"source document not found: {SOURCE}")
        return 2

    expected = source_paragraphs(SOURCE)
    shipped = code_paragraphs(BLOCKS)

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
    print(f"{ok}/{len(MANIFEST)} block paragraphs verbatim from {SOURCE.name}")
    return 1 if altered or missing else 0


if __name__ == "__main__":
    sys.exit(main())

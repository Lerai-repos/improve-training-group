"""Trek {thema: {labelcode: productcode}} uit ITG's Productcodes-werkblad.

Negen blokken naast elkaar, elk `Training | Productcode`, met per blok een eigen themalijst
in een eigen volgorde. Namen worden getrimd: de blokken Firma Vitaliteit en WorkJoy hebben
voorloopspaties, en zonder trimmen matcht daar niets.

Het blok 'Losse labels' (Y/Z) blijft eruit: dat zijn codes voor een heel label zonder thema.
"""

from __future__ import annotations

import json
import sys
import zipfile
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
BLOCKS = [("IT", "A", "B"), ("JE", "D", "E"), ("TT", "G", "H"), ("SST", "J", "K"),
          ("FV", "M", "N"), ("WJ", "P", "Q"), ("CC", "S", "T"), ("CP", "V", "W")]
FIRST_DATA_ROW = 6


def main(path: str) -> None:
    z = zipfile.ZipFile(path)
    shared = [
        "".join(t.text or "" for t in si.iter(NS + "t"))
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(NS + "si")
    ]
    sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))

    rows: dict[int, dict[str, str]] = {}
    for row in sheet.iter(NS + "row"):
        cells: dict[str, str] = {}
        for c in row.iter(NS + "c"):
            column = "".join(ch for ch in c.get("r", "") if ch.isalpha())
            v = c.find(NS + "v")
            if v is None or v.text is None:
                continue
            cells[column] = shared[int(v.text)] if c.get("t") == "s" else v.text
        if cells:
            rows[int(row.get("r", "0"))] = cells

    out: dict[str, dict[str, str]] = {}
    for label, theme_col, code_col in BLOCKS:
        for r in sorted(rows):
            if r < FIRST_DATA_ROW:
                continue
            theme = (rows[r].get(theme_col) or "").strip()
            code = (rows[r].get(code_col) or "").strip()
            if theme and code:
                out.setdefault(theme, {})[label] = code

    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main(sys.argv[1])

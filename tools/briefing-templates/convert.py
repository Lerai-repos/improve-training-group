"""Turn an ITG .dotx briefing template into a docx-templates template.

One-off build tool: reads ITG's source, writes a converted .docx with +++field+++
commands, the two rows they never added, and the v2.0 row order.
"""
import copy, re, sys, zipfile

import xmlkeep
from xml.etree import ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
ET.register_namespace('w', W[1:-1])

# label in the left cell -> placeholder for the right cell. Order IS the v2.0 order.
# (label, field, aliases). The first row's label is the LABEL'S OWN TERM — IT says
# Training, TT says Teambuilding, CC says Cursus — so it is matched on aliases and the
# source's own wording is kept. CC also renamed two more rows, with a doubled s in both;
# those typos are corrected rather than carried forward.
ROWS = [
    ('Opdrachtgever',        'opdrachtgever'),
    ('Training',             'thema', ('Training', 'Workshop', 'Teambuilding', 'Cursus')),
    ('Klanttitel',           'klanttitel'),          # new
    ('Duur',                 'duur'),
    ('Datum & tijd',         'datumTijd'),
    ('Groepsgrootte',        'groepsgrootte'),
    ('Trainingslocatie',     'locatie', ('Trainingslocatie', 'Cursusslocatie')),
    ('Voertaal',             'voertaal'),
    ('Materialen uiterlijk op', 'materialenDeadline'),  # new
    ('Accountmanager',       'accountmanager'),
    ('Km. / Reistijd',       'reis'),
    ('Contactpersoon',       'contactpersoon'),
    ('Klantcontactmoment',   'klantcontactmoment'),
    ('Evaluatie deelnemers', 'evaluatie'),
    ('IE-code',              'iecode'),
    ('Trainingscode MC',     'trainingscodeMc', ('Trainingscode MC', 'Cursusscode MC')),
]

ROWS = [(r[0], r[1], r[2] if len(r) > 2 else (r[0],)) for r in ROWS]


def cell_text(tc):
    return ''.join(n.text or '' for n in tc.iter(W + 't')).strip()

def label_of(tr):
    tcs = tr.findall(W + 'tc')
    return cell_text(tcs[0]) if tcs else ''

def set_cell(tc, text):
    """Collapse a cell to ONE paragraph containing `text`, keeping its formatting.

    The value cells hold either a prompt question or a list of options (six
    accountmanagers, three klantcontactmoment values) for the AM to delete down to
    one. Both become a single placeholder, so every extra paragraph and every extra
    run has to go — but the first run's rPr is kept, or the cell loses its font.
    """
    ps = tc.findall(W + 'p')
    keep = ps[0]
    for p in ps[1:]:
        tc.remove(p)
    runs = keep.findall(W + 'r')
    if not runs:
        r = ET.SubElement(keep, W + 'r'); ET.SubElement(r, W + 't')
        runs = [r]
    for r in runs[1:]:
        keep.remove(r)
    r = runs[0]
    for t in r.findall(W + 't'):
        r.remove(t)
    for br in r.findall(W + 'br'):
        r.remove(br)
    t = ET.SubElement(r, W + 't')
    t.text = text
    t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')

def convert_table(tbl):
    trs = tbl.findall(W + 'tr')
    by_label = {}
    for tr in trs:
        by_label.setdefault(label_of(tr), tr)

    template_row = trs[0]          # a plain two-cell row to clone for the new ones
    new_rows, created = [], []
    for label, field, aliases in ROWS:
        src = next((by_label[a] for a in aliases if a in by_label), None)
        found = next((a for a in aliases if a in by_label), None)
        if src is None:
            src = copy.deepcopy(template_row)
            created.append(label)
        tcs = src.findall(W + 'tc')
        # Keep the template's own term (Workshop / Teambuilding / Cursus), but correct
        # CC's doubled-s spellings by falling back to the canonical label.
        keep = found if found and 'ss' not in found.lower() else label
        set_cell(tcs[0], keep)
        # The MC cell keeps its hard reminder; everything else is just the value.
        value = f'+++{field}+++'
        if label == 'Trainingscode MC':
            value += ' <-- Vergeet de Monday Challenges niet!'
        set_cell(tcs[1], value)
        new_rows.append(src)

    for tr in trs:
        tbl.remove(tr)
    # Rows must go back where they were: after tblPr/tblGrid, not at the end.
    idx = len(tbl) - len([c for c in tbl if c.tag == W + 'tr'])
    for i, tr in enumerate(new_rows):
        tbl.insert(idx + i, tr)
    return created

def convert(src_path, dst_path):
    zin = zipfile.ZipFile(src_path)
    out = {}
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == 'word/document.xml':
            root, root_tag = xmlkeep.parse(data)
            tables = [t for t in root.iter(W + 'tbl')
                      if any(label_of(r) in ('Trainingscode MC', 'Cursusscode MC') for r in t.findall(W + 'tr'))]
            if len(tables) != 2:
                raise SystemExit(f'{src_path}: expected 2 data tables, found {len(tables)}')
            created = [convert_table(t) for t in tables]
            data = xmlkeep.serialise(root, root_tag)
            print(f'  rows added: {created[0]}')
        if item.filename == '[Content_Types].xml':
            data = data.decode('utf8').replace(
                'wordprocessingml.template.main+xml',
                'wordprocessingml.document.main+xml').encode('utf8')
        out[item.filename] = (item, data)
    with zipfile.ZipFile(dst_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for item, data in out.values():
            z.writestr(item, data)

if __name__ == '__main__':
    convert(sys.argv[1], sys.argv[2])
    print(f'  wrote {sys.argv[2]}')

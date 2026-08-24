"""Turn an ITG .dotx briefing template into a docx-templates template.

One-off build tool: reads ITG's source, writes a converted .docx with +++field+++
commands, the two rows they never added, and the v2.0 row order.
"""
import copy, re, sys, zipfile

import xmlkeep
from xml.etree import ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
MC = '{http://schemas.openxmlformats.org/markup-compatibility/2006}'
ET.register_namespace('w', W[1:-1])

# De twee blokken die ITG in hun ECHTE briefings niet in een tekstvak zetten.
#
# Gemeten op `2.0 ITG vb Briefing Probiblio`: de intro staat daar als gewone alinea's
# (body 45-55) en de tabel als gewone tabel (body 62). Alleen de disclaimer en de kopband
# `Algemeen.` blijven bij hen een tekstvak, dus die laten we met rust.
#
# Waarom het uitmaakt: een tekstvak is in Word geen klik-en-typ maar een tekenobject, en
# Google Docs laat het bij het openen helemaal weg — daar verdween de hele tabel.
#
# `spatie_voor` is de eigen V-offset van het tekstvak, in twips. Het introvak stond 1,9 cm
# onder zijn anker omdat de kopband `Algemeen.` tot 1 cm onder de bovenmarge doorloopt;
# zonder die ruimte loopt de eerste regel eronder.
CM = 566.9
UNWRAP = (
    ('intro', ('Binnenkort organiseer je',), round(1.9 * CM)),
    ('gegevenstabel', ('Trainingscode MC', 'Cursusscode MC'), 0),
)

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


def set_space_before(p, twips):
    """Zet de ruimte boven een alinea, zodat hij op dezelfde hoogte begint als het vak."""
    if twips <= 0 or p.tag != W + 'p':
        return
    ppr = p.find(W + 'pPr')
    if ppr is None:
        ppr = ET.Element(W + 'pPr')
        p.insert(0, ppr)
    sp = ppr.find(W + 'spacing')
    if sp is None:
        sp = ET.SubElement(ppr, W + 'spacing')
    sp.set(W + 'before', str(twips))


def unwrap_box(body, naam, markers, spatie_voor):
    """Til een zwevend tekstvak uit de opmaak naar de gewone documentstroom.

    De ankeralinea BLIJFT staan en blijft leeg achter. Dat is geen slordigheid: de andere
    tekstvakken op die pagina zijn gepositioneerd `relativeFrom="paragraph"`, dus ze
    schuiven mee met hun anker. Zou de inhoud vóór het anker komen, dan zakt de kopband
    `Algemeen.` de pagina af en verdwijnt de disclaimer eronderuit.

    Het pagina-einde verhuist mee naar áchter de opgetilde inhoud, anders belandt die op
    de volgende pagina in plaats van op zijn eigen.
    """
    for idx, para in enumerate(list(body)):
        for run in para.iter(W + 'r'):
            for alt in list(run.findall(MC + 'AlternateContent')):
                choice = alt.find(MC + 'Choice')
                box = choice.find('.//' + W + 'txbxContent') if choice is not None else None
                if box is None:
                    continue
                text = ''.join(t.text or '' for t in box.iter(W + 't'))
                if not any(m in text for m in markers):
                    continue
                kids = list(box)
                # Het hele AlternateContent weg: de Fallback is een tweede kopie van
                # dezelfde inhoud, en die zou na het optillen dubbel in het document staan.
                run.remove(alt)
                for i, kid in enumerate(kids):
                    body.insert(idx + 1 + i, kid)
                if kids:
                    set_space_before(kids[0], spatie_voor)
                move_page_break(para, body, idx + len(kids))
                print(f'  {naam}: {len(kids)} element(en) uit het tekstvak gehaald')
                return kids
    raise SystemExit(f'{naam}: geen tekstvak gevonden met {markers}')


def move_page_break(para, body, after_idx):
    """Het pagina-einde van de ankeralinea naar achter de opgetilde inhoud."""
    for run in para.iter(W + 'r'):
        for br in list(run.findall(W + 'br')):
            if br.get(W + 'type') != 'page':
                continue
            run.remove(br)
            p = ET.Element(W + 'p')
            r = ET.SubElement(p, W + 'r')
            nb = ET.SubElement(r, W + 'br')
            nb.set(W + 'type', 'page')
            body.insert(after_idx + 1, p)
            return


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

def drop_extra_columns(tbl, keep=2):
    """Kolommen voorbij `keep` weggooien, en zeggen dat we het doen.

    Het FT-sjabloon heeft een DERDE kolom met een ingevuld voorbeeld: een echte klantnaam,
    een echt thema en de naam plus het 06-nummer van een accountmanager. Alleen kolom 1 en
    2 aanpassen liet die gegevens gewoon staan, en ze waren daarmee op weg naar Git.

    Ook `tblGrid` moet mee krimpen, anders rekent Word met meer kolommen dan er zijn.
    """
    trs = tbl.findall(W + 'tr')
    widest = max((len(tr.findall(W + 'tc')) for tr in trs), default=0)
    if widest <= keep:
        return 0
    for tr in trs:
        for tc in tr.findall(W + 'tc')[keep:]:
            tr.remove(tc)
    grid = tbl.find(W + 'tblGrid')
    if grid is not None:
        for col in grid.findall(W + 'gridCol')[keep:]:
            grid.remove(col)
    return widest - keep


def convert_table(tbl):
    dropped = drop_extra_columns(tbl)
    if dropped:
        print(f'  let op: {dropped} extra kolom(men) met voorbeelddata verwijderd')
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
        if len(tcs) != 2:
            raise SystemExit(
                f'rij "{label}" heeft {len(tcs)} cellen, verwacht 2 — sjabloonopbouw '
                'onverwacht, controleer met de hand'
            )
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
            body = root.find(W + 'body')
            for naam, markers, spatie in UNWRAP:
                unwrap_box(body, naam, markers, spatie)
            tables = [t for t in root.iter(W + 'tbl')
                      if any(label_of(r) in ('Trainingscode MC', 'Cursusscode MC') for r in t.findall(W + 'tr'))]
            # Eén, niet twee: het optillen heeft de mc:Fallback-kopie van de tabel
            # weggenomen. Bleven het er twee, dan staat de tabel dubbel in het document.
            if len(tables) != 1:
                raise SystemExit(
                    f'{src_path}: verwachtte 1 gegevenstabel na het optillen, vond {len(tables)}')
            created = convert_table(tables[0])
            data = xmlkeep.serialise(root, root_tag)
            print(f'  rows added: {created}')
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

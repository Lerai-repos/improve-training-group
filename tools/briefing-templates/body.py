"""Second pass: put the body-section commands into a converted template.

The table is done by convert.py. This adds the parts that are lists rather than
values: achtergrondinformatie, the programme bullets, the conditional blocks and the
inventarisatie. Each is a FOR loop, so the CODE decides what goes in and in what
order, and the template only says "here".
"""
import copy, sys, zipfile

import xmlkeep
from xml.etree import ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
XS = '{http://www.w3.org/XML/1998/namespace}space'
ET.register_namespace('w', W[1:-1])


def txt(e):
    return ''.join(n.text or '' for n in e.iter(W + 't')).strip()


def para_like(model, text):
    """A copy of `model` holding exactly `text`, so inserted lines inherit its style."""
    p = copy.deepcopy(model)
    for extra in p.findall(W + 'r')[1:]:
        p.remove(extra)
    runs = p.findall(W + 'r')
    if not runs:
        r = ET.SubElement(p, W + 'r')
    else:
        r = runs[0]
        for t in list(r.findall(W + 't')) + list(r.findall(W + 'br')):
            r.remove(t)
    t = ET.SubElement(r, W + 't')
    t.text = text
    t.set(XS, 'preserve')
    return p



# Kolommen van de historie-tabel, letterlijk uit ITG's bronbestand:
# "Tabel met onderstaande kolommen: Datum | Tijd | Klanttitel | Trainer (tel nr) | CP klant"
HISTORIE_KOLOMMEN = [
    ('Datum', '+++$h.datum+++'),
    ('Tijd', '+++$h.tijd+++'),
    ('Klanttitel', '+++$h.klanttitel+++'),
    ('Trainer (tel nr)', '+++$h.trainer+++'),
    ('CP klant', '+++$h.contactpersoon+++'),
]

# Twaalf centimeter tekstbreedte, gelijk verdeeld. In twintigsten van een punt (dxa).
TABEL_BREEDTE_DXA = 9060


def cel(model_para, text, breedte):
    tc = ET.Element(W + 'tc')
    pr = ET.SubElement(tc, W + 'tcPr')
    w = ET.SubElement(pr, W + 'tcW')
    w.set(W + 'w', str(breedte))
    w.set(W + 'type', 'dxa')
    tc.append(para_like(model_para, text))
    return tc


def historie_tabel(model_para):
    """Een echte Word-tabel voor de historie, met een koprij en één FOR-rij.

    Waarom een tabel en geen alinea's met streepjes ertussen: zodra een klanttitel of een
    trainersnaam over twee regels loopt, staan de kolommen niet meer onder elkaar en is het
    geen tabel meer maar een brij. ITG's bronbestand vraagt hier letterlijk om een tabel.

    De rij zit tussen `FOR h` en `END-FOR h`, die in eigen alinea's in de eerste cel staan;
    docx-templates herhaalt dan de hele rij.
    """
    breedte = TABEL_BREEDTE_DXA // len(HISTORIE_KOLOMMEN)
    tbl = ET.Element(W + 'tbl')
    pr = ET.SubElement(tbl, W + 'tblPr')
    tw = ET.SubElement(pr, W + 'tblW')
    tw.set(W + 'w', str(TABEL_BREEDTE_DXA))
    tw.set(W + 'type', 'dxa')
    borders = ET.SubElement(pr, W + 'tblBorders')
    for kant in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        b = ET.SubElement(borders, W + kant)
        b.set(W + 'val', 'single')
        b.set(W + 'sz', '4')
        b.set(W + 'color', 'BFBFBF')
    grid = ET.SubElement(tbl, W + 'tblGrid')
    for _ in HISTORIE_KOLOMMEN:
        gc = ET.SubElement(grid, W + 'gridCol')
        gc.set(W + 'w', str(breedte))

    def rij(waarden):
        tr = ET.SubElement(tbl, W + 'tr')
        for waarde in waarden:
            tr.append(cel(model_para, waarde, breedte))
        return tr

    leeg = [''] * (len(HISTORIE_KOLOMMEN) - 1)

    # De FOR en de END-FOR staan in EIGEN rijen, boven en onder de datarij.
    #
    # Gemeten met drie varianten tegen docx-templates 4.15, want de plaatsing bepaalt wát er
    # herhaald wordt:
    #
    #   beide in de datarij      -> de CELLEN herhalen: één rij die steeds breder wordt
    #   FOR in de koprij         -> de koprij herhaalt mee, in elke datarij opnieuw
    #   eigen rijen (dit)        -> precies de datarij herhaalt
    #
    # De twee commandorijen verdwijnen bij het renderen; dat is geverifieerd op de uitvoer en
    # niet aangenomen.
    rij([label for label, _ in HISTORIE_KOLOMMEN])
    rij(['+++FOR h IN $blk.historie+++', *leeg])
    rij([veld for _, veld in HISTORIE_KOLOMMEN])
    rij(['+++END-FOR h+++', *leeg])
    return tbl


def build(src, dst):
    zin = zipfile.ZipFile(src)
    parts = {}
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == 'word/document.xml':
            root, root_tag = xmlkeep.parse(data)
            data = xmlkeep.serialise(rewrite(root), root_tag)
        parts[item.filename] = (item, data)
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:
        for item, d in parts.values():
            z.writestr(item, d)


# Hoe vaak elke ankertekst hóórt voor te komen. De achtergrondalinea's staan in een
# tekstvak en staan daarom twee keer in de XML (Choice + Fallback); de twee koppen staan
# in de gewone body en dus één keer. Wijkt een sjabloon af, dan stoppen we — anders komt
# een sectie stilletjes dubbel in de briefing.
EXPECTED = {'lorem': 2, 'tail': 2, 'intro': 1, 'inv': 1}


def drop_duplicate_sections(root, parents, anchors):
    """Een direct herhaalde (kop, intro) verwijderen, en zeggen dat we het doen.

    Het FT-sjabloon bevat 'Inventarisatie klant' plus zijn inleiding twee keer achter
    elkaar, een kopieerfoutje van ITG. Zonder dit staat de hele vragenlijst dubbel in
    elke FT-briefing.
    """
    if len(anchors) <= 1:
        return anchors[:1]
    for extra in anchors[1:]:
        parent = parents[extra]
        kids = list(parent)
        at = kids.index(extra)
        # de kop erboven hoort bij deze dubbele sectie
        if at > 0 and txt(kids[at - 1]).startswith('Inventarisatie klant'):
            parent.remove(kids[at - 1])
        parent.remove(extra)
    print(f'  let op: {len(anchors) - 1} dubbele sectie(s) verwijderd')
    return anchors[:1]


def rewrite(root):
    parents = {c: p for p in root.iter() for c in p}

    def replace_with(model, lines):
        """Swap one paragraph for a list of paragraphs in the same place.

        An entry may also be a ready-made element (the historie table); that one is inserted
        as it is instead of being wrapped in a paragraph.
        """
        parent = parents[model]
        kids = list(parent)
        at = kids.index(model)
        parent.remove(model)
        for i, line in enumerate(lines):
            node = copy.deepcopy(line) if ET.iselement(line) else para_like(model, line)
            parent.insert(at + i, node)

    lorem = [p for p in root.iter(W + 'p') if txt(p).startswith('Lorem ipsum')]
    tail = [p for p in root.iter(W + 'p') if txt(p).startswith('Vestibulum non malesuada')]
    intro = [p for p in root.iter(W + 'p')
             if txt(p).startswith('Het volgende concept programma')]
    inv = [p for p in root.iter(W + 'p')
           if txt(p).startswith('Onderstaande informatie komt uit')]

    found = {'lorem': len(lorem), 'tail': len(tail), 'intro': len(intro), 'inv': len(inv)}
    if found['inv'] > EXPECTED['inv']:
        inv = drop_duplicate_sections(root, parents, inv)
        found['inv'] = len(inv)
    if found != EXPECTED:
        raise SystemExit(f'onverwachte sjabloonopbouw: {found}, verwacht {EXPECTED}')

    # Achtergrondinformatie: the two lorem paragraphs become the loop, then the
    # marked Monday-updates, then the hard Monday Challenge line.
    for p in lorem:
        replace_with(p, [
            '+++FOR a IN achtergrond+++', '+++$a+++', '+++END-FOR a+++',
            '+++IF extraInfo.length+++', 'Extra informatie trainer',
            '+++FOR e IN extraInfo+++', '+++$e+++', '+++END-FOR e+++',
            '+++END-IF+++',
            '+++IF mondayChallenge+++',
            '!! Vergeet de Monday Challenges niet aan te bieden in je sessie !!',
            '+++END-IF+++',
        ])
    for p in tail:
        parents[p].remove(p)

    # Concept inhoud: the bullets, then every conditional block the code decided on.
    for p in intro:
        replace_with(p, [
            'Het volgende concept programma is gecommuniceerd met de klant.',
            '+++FOR b IN bullets+++', '+++$b+++', '+++END-FOR b+++',
            '+++FOR blk IN blokken+++', '+++$blk.titel+++',
            '+++FOR r IN $blk.regels+++', '+++$r+++', '+++END-FOR r+++',
            # The training-cycle block carries a diagram; every other block leaves this empty.
            # IMAGE needs the call parentheses, and the function comes from additionalJsContext.
            '+++IF $blk.afbeelding+++', '+++IMAGE blockImage($blk)+++', '+++END-IF+++',
            # Vaste klant brings the historie table; every other block leaves it empty.
            '+++IF $blk.historie+++', historie_tabel(p), '', '+++END-IF+++',
            '+++END-FOR blk+++',
        ])

    # Inventarisatie: question and answer, or one replacement line when it is empty.
    for p in inv:
        replace_with(p, [
            'Onderstaande informatie komt uit het inventarisatieformulier. '
            'Gebruik de context en casuïstiek als input voor de workshop.',
            '+++IF inventarisatie.length+++',
            '+++FOR v IN inventarisatie+++', '+++$v.vraag+++', '+++$v.antwoord+++',
            '+++END-FOR v+++', '+++END-IF+++',
            '+++IF !inventarisatie.length+++',
            'Het inventarisatieformulier is (nog) niet ingevuld door de klant.',
            '+++END-IF+++',
        ])
    return root


if __name__ == '__main__':
    build(sys.argv[1], sys.argv[2])
    print(f'  wrote {sys.argv[2]}')

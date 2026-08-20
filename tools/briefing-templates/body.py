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
        """Swap one paragraph for a list of paragraphs in the same place."""
        parent = parents[model]
        kids = list(parent)
        at = kids.index(model)
        parent.remove(model)
        for i, line in enumerate(lines):
            parent.insert(at + i, para_like(model, line))

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

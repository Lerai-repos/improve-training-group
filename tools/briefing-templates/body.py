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



# De opsomming die het sjabloon al kent. `numbering.xml` definieert er drie en ze zijn
# alle drie identiek: numFmt=bullet, teken U+F0B7 in Symbol, inspringen 720. Dat is
# exact dezelfde definitie als `numId 5` in ITG's eigen verstuurde briefing, waar de
# concept-regels wél een echte Word-opsomming zijn.
#
# Vóór 24-Aug-2026 gebruikte geen enkele alinea in het sjabloon deze definities, dus
# kwamen de concept-regels als gewone alinea's uit de generator.
BULLET_NUM_ID = '1'

# Waar `numPr` in `pPr` mag staan. De OOXML-volgorde is vast: pStyle, keepNext, keepLines,
# pageBreakBefore, framePr, widowControl, numPr. Zet je het ervoor, dan noemt Word het
# bestand beschadigd — dezelfde stille totale fout als een ontbrekende namespace.
VOOR_NUMPR = ('pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl')


def bullet_para(model, text):
    """Een alinea als `para_like`, maar dan als opsommingsteken."""
    p = para_like(model, text)
    ppr = p.find(W + 'pPr')
    if ppr is None:
        ppr = ET.Element(W + 'pPr')
        p.insert(0, ppr)
    for oud in ppr.findall(W + 'numPr'):
        ppr.remove(oud)
    numpr = ET.Element(W + 'numPr')
    ET.SubElement(numpr, W + 'ilvl').set(W + 'val', '0')
    ET.SubElement(numpr, W + 'numId').set(W + 'val', BULLET_NUM_ID)
    at = 0
    for kind in list(ppr):
        if kind.tag.replace(W, '') in VOOR_NUMPR:
            at += 1
        else:
            break
    ppr.insert(at, numpr)
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


# Hoe vaak elke ankertekst hóórt voor te komen. Wijkt een sjabloon af, dan stoppen we —
# anders komt een sectie stilletjes dubbel in de briefing.
#
# Alles staat één keer. Tot 24-Aug-2026 stonden de achtergrondalinea's er twee keer, omdat
# ze in het tekstvak van de gegevenstabel zaten en dus zowel in `mc:Choice` als in
# `mc:Fallback` voorkwamen. `convert.py` tilt die tabel nu uit het tekstvak en gooit de
# Fallback-kopie weg, dus die verdubbeling bestaat niet meer.
EXPECTED = {'lorem': 1, 'tail': 1, 'intro': 1, 'inv': 1}


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


def strip_yellow_highlight(root):
    """ITG's gele markering weghalen; die betekent "hier moet nog iets in".

    Hun `.dotx` heeft er 374 en ze staan op de in te vullen tekst. Wij vullen die tekst
    automatisch, dus blijft de markering staan op een veld dat al af is — de hele briefing
    komt dan geel uit de generator. In ITG's eigen verstuurde briefing staat op geen enkele
    letter nog een markering: de adviseur haalt hem er met de hand af.

    Cyaan blijft staan. Dat is er maar één, op de regel "Vergeet de Monday Challenges niet",
    en dat is een opmerking voor de trainer en geen invulmarkering.
    """
    weg = 0
    for rpr in root.iter(W + 'rPr'):
        for h in list(rpr.findall(W + 'highlight')):
            if h.get(W + 'val') == 'yellow':
                rpr.remove(h)
                weg += 1
    if weg:
        print(f'  gele markering van {weg} run(s) gehaald')


def strip_lege_voor(root, parents, kop_tekst):
    """Alle lege alinea's vlak vóór een kop weghalen.

    De witruimte tussen secties wordt daarna op één plek bepaald: elke sectie brengt zijn
    eigen witregel mee, vóór zijn titel. Anders telt de afstand op uit twee bronnen — het
    brondocument had er drie staan vóór de rolblokken — en hangt het resultaat af van of een
    lus toevallig iets heeft opgeleverd. Zonder rolblokken stonden er zo drie witregels vóór
    `Concept inhoud`, met rolblokken één.
    """
    kop = [p for p in root.iter(W + 'p') if txt(p).strip() == kop_tekst]
    if len(kop) != 1:
        raise SystemExit(f'verwachtte 1 kop "{kop_tekst}", vond {len(kop)}')
    parent = parents[kop[0]]
    kids = list(parent)
    at = kids.index(kop[0])
    weg = 0
    while at - 1 - weg >= 0 and txt(kids[at - 1 - weg]).strip() == '':
        parent.remove(kids[at - 1 - weg])
        weg += 1
    return weg


def blok_regels(model):
    """De regels van één blok: opsommingsteken of gewone alinea, per regel.

    Twee alinea's met elk een `IF`, en niet één alinea die zich aanpast: `docx-templates`
    kan tekst weglaten of invoegen, maar niet de opmaak van een alinea omzetten. Welke van
    de twee overblijft bepaalt `$r.bullet`, en die vlag komt uit ITG's eigen brondocument.
    """
    return [
        '+++FOR r IN $blk.regels+++',
        '+++IF $r.bullet+++',
        bullet_para(model, '+++$r.tekst+++'),
        '+++END-IF+++',
        '+++IF !$r.bullet+++',
        '+++$r.tekst+++',
        '+++END-IF+++',
        '+++END-FOR r+++',
    ]


def rewrite(root):
    strip_yellow_highlight(root)
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
            # GEEN Monday Challenges-regel hier.
            #
            # ITG's `.dotx` heeft er zelf al een, cyaan gemarkeerd, in het tekstvak met de
            # intro en de gegevenstabel; `convert.py` tilt dat op, dus staat hij boven de
            # tabel. Samen met de kolom `Trainingscode MC` in de tabel zelf is dat twee keer,
            # en dat is wat ITG wil. Een derde vermelding hier maakte er drie van.
            # Tim, 28-Aug-2026: "the cyan one and the one in the table are correct".
        ])
    for p in tail:
        parents[p].remove(p)

    # De rolblokken staan BOVEN "Concept inhoud": de trainer leest eerst wat er van hem
    # verwacht wordt, dan pas het programma. Tim, 24-Aug-2026: "i think it should be above
    # the concept inhoud. So the page starts with that."
    #
    # Vóór de intro-vervanging hieronder, want die haalt de alinea weg die hier nog als
    # opmaakmodel dient.
    kop = [p for p in root.iter(W + 'p') if txt(p).strip() == 'Concept inhoud']
    if len(kop) != 1:
        raise SystemExit(f'verwachtte 1 kop "Concept inhoud", vond {len(kop)}')
    model = intro[0]
    # Het brondocument zet er drie neer; de witruimte komt hieronder uit één regel.
    strip_lege_voor(root, parents, 'Concept inhoud')
    voor = [
        '+++FOR blk IN rolblokken+++',
        # De witregel hoort VÓÓR de titel, niet erna.
        #
        # Erna telt hij op bij de witregels die al vóór de volgende kop staan, en dan hangt
        # de afstand af van hoeveel blokken de lus opleverde: geen rolblokken gaf drie
        # witregels vóór "Concept inhoud", één rolblok gaf er één. Ervóór brengt elke sectie
        # precies zijn eigen witregel mee, en is de afstand overal gelijk.
        '',
        para_like(kop[0], '+++$blk.titel+++'),
        *blok_regels(model),
        '+++END-FOR blk+++',
        # De vaste witregel vóór "Concept inhoud", ook als er geen enkel rolblok is.
        '',
    ]
    parent = parents[kop[0]]
    at = list(parent).index(kop[0])
    for i, regel in enumerate(voor):
        node = copy.deepcopy(regel) if ET.iselement(regel) else para_like(model, regel)
        parent.insert(at + i, node)

    # Concept inhoud: the bullets, then every conditional block the code decided on.
    for p in intro:
        replace_with(p, [
            'Het volgende concept programma is gecommuniceerd met de klant.',
            # Alleen de regel zelf is een opsommingsteken; docx-templates haalt de
            # FOR- en END-FOR-alinea's weg, dus die blijven gewoon.
            '+++FOR b IN bullets+++', bullet_para(p, '+++$b+++'), '+++END-FOR b+++',
            # Dezelfde kopstijl als de rolblokken hierboven, uit dezelfde bron: de alinea
            # "Concept inhoud" draagt `Kop1`. Zonder dit kwamen `Vaste klant`,
            # `Huiswerkopdracht`, `Voorbereidende opdracht` en de cyclus als gewone alinea's
            # uit de generator, terwijl `Leadtrainer` ernaast wél een kop was — dezelfde
            # soort titel, twee verschillende opmaken, in één document.
            # Zelfde regel als bij de rolblokken: de witregel gaat vóór de titel.
            '+++FOR blk IN blokken+++', '', para_like(kop[0], '+++$blk.titel+++'),
            *blok_regels(p),
            # The training-cycle block carries a diagram; every other block leaves this empty.
            # IMAGE needs the call parentheses, and the function comes from additionalJsContext.
            '+++IF $blk.afbeelding+++', '+++IMAGE blockImage($blk)+++', '+++END-IF+++',
            # Vaste klant brings the historie table; every other block leaves it empty.
            '+++IF $blk.historie+++', historie_tabel(p), '+++END-IF+++',
            '+++END-FOR blk+++',
        ])

    # Vóór "Inventarisatie klant" hetzelfde: alles weg, dan precies één terug. Het laatste
    # blok laat er nu geen meer achter, dus zonder dit plakt de kop tegen de historie-tabel.
    strip_lege_voor(root, parents, 'Inventarisatie klant')
    inv_kop = [p for p in root.iter(W + 'p') if txt(p).strip() == 'Inventarisatie klant'][0]
    inv_parent = parents[inv_kop]
    inv_parent.insert(list(inv_parent).index(inv_kop), para_like(intro[0], ''))

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

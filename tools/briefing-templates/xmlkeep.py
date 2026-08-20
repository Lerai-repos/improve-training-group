"""Parse and re-serialise word/document.xml without losing namespace declarations.

ElementTree only writes the namespaces it thinks are used, but `mc:Ignorable` names
prefixes that must stay DECLARED even when nothing in the body uses them. Drop them and
Word calls the file corrupt — the failure is total and silent until someone opens it.

So: register every prefix from the original root before parsing, and splice the original
root tag back over the generated one afterwards.
"""
import re
from xml.etree import ElementTree as ET

ROOT_RE = re.compile(r'<(\w+):document[^>]*>')


def parse(data: bytes):
    text = data.decode('utf8')
    m = ROOT_RE.search(text)
    if m is None:
        raise ValueError('no <w:document> root found')
    root_tag = m.group(0)
    for prefix, uri in re.findall(r'xmlns:([A-Za-z0-9]+)="([^"]+)"', root_tag):
        # ElementTree reserves nsN for itself and refuses to register one. Those only
        # appear on a document we generated ourselves; skipping them is safe because
        # the declaration is carried through verbatim by serialise() anyway.
        if re.fullmatch(r'ns\d+', prefix):
            continue
        ET.register_namespace(prefix, uri)
    return ET.fromstring(text), root_tag


def serialise(root, root_tag: str) -> bytes:
    out = ET.tostring(root, encoding='unicode')
    m = ROOT_RE.search(out)
    if m is None:
        raise ValueError('serialised document lost its root')

    # Keep every declaration from BOTH roots. The original carries the ten prefixes
    # `mc:Ignorable` names; the generated one carries any that ElementTree had to invent
    # for namespaces the original declared elsewhere. Dropping either half unbinds a
    # prefix somewhere in the body, and Word refuses the file.
    have = dict(re.findall(r'xmlns:([A-Za-z0-9]+)="([^"]+)"', root_tag))
    extra = [f' xmlns:{p}="{u}"'
             for p, u in re.findall(r'xmlns:([A-Za-z0-9]+)="([^"]+)"', m.group(0))
             if p not in have]
    merged = root_tag[:-1] + ''.join(extra) + '>'
    out = out[:m.start()] + merged + out[m.end():]
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + out).encode('utf8')

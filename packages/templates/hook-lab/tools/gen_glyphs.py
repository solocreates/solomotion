"""Regenerates hook-lab/glyphs.js (not shipped: the bundle takes .js/.json/.md/.svg only).

  1. Fraunces (variable) from google/fonts: ofl/fraunces/Fraunces[SOFT,WONK,opsz,wght].ttf, instanced here at
     SOFT 100, WONK 1, wght 800, opsz 144 — the axes a text layer can't set:
       python3 -c "from fontTools.ttLib import TTFont; from fontTools.varLib.instancer import instantiateVariableFont as I; \
         I(TTFont('Fraunces.ttf'), {'wght':800,'SOFT':100,'WONK':1,'opsz':144}).save('fonts/Fraunces-hero.ttf')"
  2. Hershey Script Simplex (public domain): kamalmostafa/hershey-fonts, hershey-fonts/scripts.jhf → hershey/scripts.jhf
  3. python3 gen_glyphs.py ../glyphs.js   (run from a folder holding fonts/ and hershey/)
"""
import json, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

OUT = sys.argv[1]
CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?'’-–:&#×✓/+"
f = TTFont("fonts/Fraunces-hero.ttf")
gs = f.getGlyphSet(); cmap = f.getBestCmap(); upm = f["head"].unitsPerEm
S = 1000 / upm
def r(v): return round(v, 1)
glyphs = {}
name_of = {}
for ch in CHARS:
    gn = cmap.get(ord(ch))
    if gn is None: print("missing", ch); continue
    name_of[gn] = ch
    pen = SVGPathPen(gs, ntos=lambda v: ("%.1f" % v).rstrip("0").rstrip("."))
    tp = TransformPen(pen, (S, 0, 0, -S, 0, 0))   # y down, baseline 0, 1000/em
    gs[gn].draw(tp)
    bp = BoundsPen(gs); gs[gn].draw(bp)
    b = bp.bounds
    glyphs[ch] = [r(gs[gn].width * S), pen.getCommands(), [r(b[0]*S), r(-b[3]*S), r(b[2]*S), r(-b[1]*S)] if b else None]

# GPOS pair kerning (formats 1 and 2, through extension lookups)
kern = {}
gpos = f["GPOS"].table
def val(v):
    return getattr(v, "XAdvance", 0) or 0 if v is not None else 0
for li in gpos.FeatureList.FeatureRecord:
    if li.FeatureTag != "kern": continue
    for idx in li.Feature.LookupListIndex:
        lk = gpos.LookupList.Lookup[idx]
        for st in lk.SubTable:
            if lk.LookupType == 9: st = st.ExtSubTable
            if st.LookupType != 2 if hasattr(st, "LookupType") else False: pass
            if not hasattr(st, "Format") or not hasattr(st, "Coverage"): continue
            cov = st.Coverage.glyphs
            if st.Format == 1:
                for i, g1 in enumerate(cov):
                    if g1 not in name_of: continue
                    for pvr in st.PairSet[i].PairValueRecord:
                        if pvr.SecondGlyph in name_of:
                            k = val(pvr.Value1)
                            key = name_of[g1] + name_of[pvr.SecondGlyph]
                            if k and key not in kern: kern[key] = r(k * S)
            elif st.Format == 2:
                c1 = st.ClassDef1.classDefs; c2 = st.ClassDef2.classDefs
                for g1 in cov:
                    if g1 not in name_of: continue
                    for g2 in name_of:
                        k = val(st.Class1Record[c1.get(g1, 0)].Class2Record[c2.get(g2, 0)].Value1)
                        key = name_of[g1] + name_of[g2]
                        if k and key not in kern: kern[key] = r(k * S)
os2 = f["OS/2"]; hh = f["hhea"]
fr = {"family": "Fraunces SOFT 100 WONK 1 800 opsz 144", "em": 1000, "asc": r(hh.ascent*S), "desc": r(-hh.descent*S), "cap": r(os2.sCapHeight*S), "xh": r(os2.sxHeight*S), "g": glyphs, "k": kern}

# Hershey script simplex: one polyline list per glyph, ascii 32..126
raw = open("hershey/scripts.jhf").read().splitlines()
recs = []; cur = ""
for line in raw:
    if cur and len(cur) >= 72 and not line[:5].strip().isdigit(): cur += line; continue
    if cur: recs.append(cur)
    cur = line
recs.append(cur)
hs = {}
for i, rec in enumerate(recs[:95]):
    n = int(rec[5:8]); data = rec[8:]
    L = ord(data[0]) - 82; R = ord(data[1]) - 82
    strokes = []; s = []
    for j in range(2, len(data) - 1, 2):
        a, b = data[j], data[j+1]
        if a == " " and b == "R":
            if s: strokes.append(s); s = []
            continue
        s += [ord(a) - 82, ord(b) - 82]
    if s: strokes.append(s)
    # Hershey weights digits and some capitals with a second, near-parallel stroke (a plotter's "bold").
    # A pencil draws each line once: drop a stroke whose every point lies within 2.6 units of a longer one.
    def near(a, b):
        pts = [(a[k], a[k+1]) for k in range(0, len(a), 2)]
        segs = [((b[k], b[k+1]), (b[k+2], b[k+3])) for k in range(0, len(b) - 2, 2)] or [((b[0], b[1]), (b[0], b[1]))]
        def dist(p, q, r):
            (px, py), (qx, qy), (rx, ry) = p, q, r
            dx, dy = rx - qx, ry - qy; L2 = dx*dx + dy*dy
            t = 0 if L2 == 0 else max(0, min(1, ((px-qx)*dx + (py-qy)*dy) / L2))
            return ((px - qx - t*dx)**2 + (py - qy - t*dy)**2) ** 0.5
        return all(min(dist(p, q, r) for q, r in segs) <= 2.6 for p in pts)
    def length(a): return sum(((a[k+2]-a[k])**2 + (a[k+3]-a[k+1])**2) ** 0.5 for k in range(0, len(a) - 2, 2))
    keep = []
    for st in sorted(strokes, key=length, reverse=True):
        if not any(near(st, k) for k in keep): keep.append(st)
    strokes = [st for st in strokes if st in keep]
    hs[chr(32 + i)] = [L, R, strokes]
out = "// GENERATED by notes/hook-lab tools (gen_glyphs.py) — glyph data the kit draws with.\n" \
      "// FRAUNCES: the hero face as outlines (SOFT 100, WONK 1, weight 800, opsz 144 — axes a text layer can't set),\n" \
      "//   1000 units per em, y down, baseline at 0: g[char] = [advance, d, inkBox[l,t,r,b]], k[pair] = kerning.\n" \
      "// SCRIPT: Hershey Script Simplex (public domain), single-line strokes for handwriting that writes on:\n" \
      "//   s[char] = [left, right, polylines], 1 unit ≈ 1/21 em (cap ≈ 21), y down, baseline at 9.\n" \
      "return " + json.dumps({"FRAUNCES": fr, "SCRIPT": hs}, ensure_ascii=False, separators=(",", ":")) + ";\n"
open(OUT, "w").write(out)
print("glyphs", len(glyphs), "kern pairs", len(kern), "script", len(hs), "bytes", len(out))
print({k: kern[k] for k in ["HO","OO","OK","KS","12","TA","AV"] if k in kern})
print(hs["o"], hs["1"])

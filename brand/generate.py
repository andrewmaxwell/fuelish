#!/usr/bin/env python3
"""Generate the Fuelish logo SVGs (stdlib only).

  python3 brand/generate.py

The mark is a 270° gauge arc made of dashes that grow longer and shift from burnt
orange to amber clockwise, ending in a glowing amber dot. All geometry comes from the
constants below, so tweak those and re-run rather than editing the SVGs by hand.
"""
import math
import os

AMBER = "#f0b429"
BG = "#0d1117"

CX, CY = 50.0, 50.0
R = 32.0            # arc radius (centre of the stroke)
W = 7.0             # dash stroke width
DOT = 5.5           # end dot radius
GAP = 4.5           # visual gap between dashes and before the dot
N = 8               # number of dashes
START, SWEEP = 135.0, 270.0   # degrees, SVG convention (0 = right, clockwise)
RAMP = ("#9c3a10", AMBER)     # colour of first and last dash; the dot is always AMBER
GROW = 3.0                    # last dash body / first dash body (1 = all equal)

OUT = os.path.dirname(os.path.abspath(__file__))


def point(deg):
    a = math.radians(deg)
    return CX + R * math.cos(a), CY + R * math.sin(a)


def to_deg(length):
    return math.degrees(length / R)


def lerp_hex(a, b, t):
    ca = [int(a[i:i + 2], 16) for i in (1, 3, 5)]
    cb = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(ca, cb))


def layout(n=N, w=W, gap=GAP, dot=DOT):
    """Return ([(start_deg, end_deg), ...] for dash cap centres, dot_deg).

    Lengths are laid out along the arc so the outer edges of the first cap and the
    dot land exactly on START and START + SWEEP, which keeps the opening symmetric.
    Dash bodies grow linearly from 1 to GROW (relative), filling what's left.
    """
    total = R * math.radians(SWEEP)
    weights = [1 + (GROW - 1) * i / (n - 1) for i in range(n)]
    bodies = total - n * (w + gap) - 2 * dot
    if bodies <= 0:
        raise SystemExit("dashes don't fit: lower N, GAP or W")
    dashes, s = [], 0.0
    for wt in weights:
        body = bodies * wt / sum(weights)
        a = s + w / 2
        dashes.append((START + to_deg(a), START + to_deg(a + body)))
        s += body + w + gap
    return dashes, START + to_deg(s + dot)


def shapes(ramp=True, scale=1.0, n=N, w=W, gap=GAP, dot=DOT):
    """Return (dashes, dot, transform) shared by the SVG and Android writers.

    dashes: [(path data, colour)], dot: (cx, cy, r), transform: (tx, ty, scale) that
    maps the 100×100 design space so the mark's bounding box is centred.
    """
    arcs, dot_deg = layout(n, w, gap, dot)
    dashes = []
    for i, (a1, a2) in enumerate(arcs):
        (x1, y1), (x2, y2) = point(a1), point(a2)
        color = lerp_hex(*RAMP, i / (n - 1)) if ramp else AMBER
        dashes.append((f"M{x1:.2f} {y1:.2f}A{R} {R} 0 0 1 {x2:.2f} {y2:.2f}", color))
    # Shift down so the bounding box (not the circle centre) is centred.
    bottom = CY + R * math.sin(math.radians(START)) + w / 2 + 1
    top = CY - R - w / 2
    shift = 50 - (top + bottom) / 2
    return dashes, (*point(dot_deg), dot), (50 - 50 * scale, 50 - 50 * scale + shift * scale, scale)


def mark(ramp=True, glow=True, scale=1.0, n=N, w=W, gap=GAP, dot=DOT):
    dashes, (cx, cy, r), (tx, ty, sc) = shapes(ramp, scale, n, w, gap, dot)
    parts = [f'<path d="{d}" stroke="{c}"/>' for d, c in dashes]
    if glow:
        parts.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r}" fill="{AMBER}" '
                     f'stroke="none" filter="url(#glow)" opacity="0.9"/>')
    parts.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r}" fill="{AMBER}" stroke="none"/>')
    return (f'<g transform="translate({tx:.2f} {ty:.2f}) scale({sc})" fill="none" '
            f'stroke-width="{w}" stroke-linecap="round">{"".join(parts)}</g>')


GLOW_DEF = ('<defs><filter id="glow" x="-1" y="-1" width="3" height="3">'
            '<feGaussianBlur stdDeviation="2.4"/></filter></defs>')


def svg(body, defs=True):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
            f'{GLOW_DEF if defs else ""}{body}</svg>\n')


def tile(radius=22):
    return f'<rect width="100" height="100" rx="{radius}" fill="{BG}"/>'


def vector(size_dp, color=None, scale=1.0, n=N, w=W, gap=GAP, dot=DOT):
    """Android VectorDrawable of the mark (no glow: vectors can't blur).

    color: None keeps the ramp; otherwise every shape gets that one colour (icons that
    the system tints, like notification and themed launcher icons, must be one colour).
    """
    dashes, (cx, cy, r), (tx, ty, sc) = shapes(color is None, scale, n, w, gap, dot)
    a = 'xmlns:android="http://schemas.android.com/apk/res/android"'
    paths = [f'        <path android:pathData="{d}" android:strokeColor="{color or c}"\n'
             f'            android:strokeWidth="{w}" android:strokeLineCap="round" />'
             for d, c in dashes]
    paths.append(f'        <path android:pathData="M{cx - r:.2f} {cy:.2f}a{r} {r} 0 1 0 {2 * r} 0'
                 f'a{r} {r} 0 1 0 {-2 * r} 0z"\n            android:fillColor="{color or AMBER}" />')
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<!-- Generated by brand/generate.py; edit that, not this. -->\n'
            f'<vector {a}\n    android:width="{size_dp}dp" android:height="{size_dp}dp"\n'
            '    android:viewportWidth="100" android:viewportHeight="100">\n'
            f'    <group android:translateX="{tx:.2f}" android:translateY="{ty:.2f}"\n'
            f'        android:scaleX="{sc}" android:scaleY="{sc}">\n'
            + "\n".join(paths) + "\n    </group>\n</vector>\n")


SMALL = dict(n=4, w=11, gap=7, dot=8)   # fewer, fatter dashes that survive at 16 px
# Adaptive icon foregrounds are 108dp, and launchers may mask to a 66dp circle, so
# the mark has to fit inside that circle.
LAUNCHER_SCALE = 0.75
RES = os.path.join(OUT, "..", "android", "app", "src", "main", "res")
WEB = os.path.join(OUT, "..", "web")

VARIANTS = {
    # Transparent mark for in-app use on dark surfaces.
    "mark.svg": svg(mark(scale=1.25)),
    # Single colour, no ramp or glow: monochrome contexts.
    "mark-flat.svg": svg(mark(ramp=False, glow=False, scale=1.25), defs=False),
    # App icon / large favicon on its own dark tile.
    "icon.svg": svg(tile() + mark(scale=1.0)),
    # Tiny favicon: fewer, fatter dashes so it survives at 16 px.
    "favicon.svg": svg(tile(18) + mark(glow=False, scale=1.15, **SMALL), defs=False),
}

COPIES = {
    os.path.join(WEB, "favicon.svg"): VARIANTS["favicon.svg"],
    # Header logo: shown at ~28px, so the mark fills more of its tile than the app icon.
    os.path.join(WEB, "logo.svg"): svg(tile() + mark(scale=1.22)),
    os.path.join(RES, "drawable", "ic_launcher_foreground.xml"):
        vector(108, scale=LAUNCHER_SCALE),
    os.path.join(RES, "drawable", "ic_launcher_monochrome.xml"):
        vector(108, color="#FFFFFFFF", scale=LAUNCHER_SCALE),
    os.path.join(RES, "drawable", "ic_notification.xml"):
        vector(24, color="#FFFFFFFF", scale=1.2, **SMALL),
}

if __name__ == "__main__":
    for name, content in VARIANTS.items():
        with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
            f.write(content)
        print(name)
    for path, content in COPIES.items():
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        print(os.path.relpath(path, os.path.join(OUT, "..")))

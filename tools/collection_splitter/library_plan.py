#!/usr/bin/env python3
"""Split plan for the colleague's Dropbox library: per-collection boundaries and the
exact metadata each split piece carries into the studio wizard.

Boundaries are measure indices (0-based) verified against the score's own movement
markings, final barlines, key/time changes AND the Sibelius engine's
BarPlaybackOrderString in the sibling diagnostics file. Naming follows the shipped
catalog conventions: title = the work or collection, subtitle = the piece's
designation within it.
"""
from __future__ import annotations

RIGHTS_NOTE = "Engraved by KaraOrchee, Inc."

# Held by the 2026-07-30 adversarial review: each is a SOURCE defect the gates cannot
# see, because the gate and the engine both read the same defective notation.
REVIEW_HOLDS = {
    "bach_invention_6": "source: forward repeat at m21 never closed — second half "
                        "plays once instead of twice, page shows a dangling open repeat",
    "mozart_k330_mvt2": "source: Dolet drops the two mid-bar ':||:' signs (it cannot "
                        "emit a mid-bar barline) — sectioning is wrong",
    "mozart_k331_mvt2": "source: no Menuetto D.C. — ships Menuetto→Trio→stop, ending "
                        "in the subdominant",
    "chopin_waltz_op34_2": "source: 50 fingerings exported as free text (stacked digits "
                           "Dolet cannot split) — they pile up at the barline",
}

# Term-derived tempo is a fallback; these two were source-corrected by the review.
TEMPO_OVERRIDE = {
    "chopin_waltz_op34_2": 150,   # "Lento" here is not ♩=52: 204 bars must run ~5:00
    "clementi_op36_5_1": 160,     # the engraver's own Sibelius MIDI tick-0 tempo
}

# Movement-name sources: Clementi/A-Info.docx, 巴赫的下载链接及版本信息.docx (BWV+key
# table), Hanon Info.docx (book-part mapping), Chopin 信息.docx (edition provenance).
CLEMENTI = [
    # (file no, key text, [(start_measure, roman, tempo_text)], blocked_by_dc)
    (1, "C major", [(0, "I", "Allegro"), (38, "II", "Andante"), (64, "III", "Vivace")], None),
    (2, "G major", [(0, "I", "Allegretto"), (61, "II", "Allegretto"), (89, "III", "Allegro")], None),
    (3, "C major", [(0, "I", "Spiritoso"), (64, "II", "Un poco adagio"), (80, "III", "Allegro")], None),
    (4, "F major", [(0, "I", "Con spirito"), (71, "II", "Andante con espressione"),
                    (117, "III", "Rondo — Allegro vivace")], 3),
    (5, "G major", [(0, "I", "Presto"), (86, "II", "Allegretto moderato — Swiss Air"),
                    (168, "III", "Rondo — Allegro di molto")], 3),
    (6, "D major", [(0, "I", "Allegro con spirito"), (92, "II", "Rondo — Allegretto spiritoso")], 2),
]

BACH_INVENTIONS = [
    # (no, start_measure, key, BWV)
    (1, 0, "C major", 772), (2, 22, "C minor", 773), (3, 49, "D major", 774),
    (4, 109, "D minor", 775), (5, 161, "E-flat major", 776), (6, 193, "E major", 777),
    (7, 255, "E minor", 778), (8, 278, "F major", 779), (9, 312, "F minor", 780),
    (10, 346, "G major", 781), (11, 378, "G minor", 782), (12, 401, "A major", 783),
    (13, 422, "A minor", 784), (14, 447, "B-flat major", 785), (15, 467, "B minor", 786),
]

# Exercises 1..38 live in the Part I file; the BOOK they belong to follows the printed
# edition (Part I = 1-20, Part II = 21-43), NOT the file split — colleague's explicit
# instruction in Hanon Info.docx.
HANON_P1_STARTS = [
    0, 30, 59, 88, 117, 146, 175, 204, 233, 262, 291, 320, 350, 379, 408, 437, 466,
    494, 523, 552, 583, 612, 641, 670, 699, 728, 757, 786, 815, 844, 872, 902, 915,
    940, 970, 1000, 1017, 1029,
]


def hanon_book(n: int) -> str:
    return "part1" if n <= 20 else ("part2" if n <= 43 else "part3")


MOZART = {
    "K330": {
        "title": "Piano Sonata No. 10, K. 330",
        "movements": [(0, "I", "Allegro moderato"), (150, "II", "Andante cantabile")],
        "end": 218,  # m218-303 are 86 empty bars — third movement not engraved yet
        "note": "third movement absent from the source file (86 rest-only bars stripped)",
    },
    "K331": {
        "title": "Piano Sonata No. 11, K. 331",
        "movements": [(0, "I", "Andante grazioso (Theme and Variations)"),
                      (137, "II", "Menuetto"), (238, "III", "Alla Turca — Allegretto")],
        "end": None,
        "note": "",
    },
}

# Score labels are the complete-waltz numbering (Op.18 = No.1), which is exactly the
# book index the colleague's 19-waltz plan uses.
CHOPIN_OP34 = [
    (0, 2, "No. 1 in A-flat major"),
    (300, 3, "No. 2 in A minor"),
    (504, 4, "No. 3 in F major"),
]

BOOKS = {
    "clementi_op36": {
        "title": "Six Sonatinas, Op. 36", "author": "Muzio Clementi",
        "publisher": "G. Schirmer", "edition": "ed. Louis Köhler, New York 1904, Plate 17134",
        "cover": "Clementi/cover.jpg",
    },
    "bach_inventions": {
        "title": "Fifteen Two-Part Inventions", "author": "Johann Sebastian Bach",
        "publisher": "Breitkopf und Härtel",
        "edition": "Bach-Gesellschaft Ausgabe, Band 3, ed. C. F. Becker, Leipzig 1853",
        "cover": "J.S.Bach/Two-Part Inventions/Two-Part Inventions.JPEG",
    },
    "hanon_part1": {
        "title": "The Virtuoso Pianist, Part I", "author": "Charles-Louis Hanon",
        "publisher": "G. Schirmer", "edition": "No. 925, New York [1900], Plate 15538",
        "cover": "Hanon/The Virtuoso Pianist Part I/Part 1.JPEG",
    },
    "hanon_part2": {
        "title": "The Virtuoso Pianist, Part II", "author": "Charles-Louis Hanon",
        "publisher": "G. Schirmer", "edition": "No. 925, New York [1900], Plate 15538",
        "cover": "Hanon/The Virtuoso Pianist Part2/Part 2.JPEG",
    },
    "chopin_waltzes": {
        "title": "Waltzes", "author": "Frédéric Chopin",
        "publisher": "Polskie Wydawnictwo Muzyczne",
        "edition": "Dzieła wszystkie, Vol. IX, ed. Narodowy Instytut Fryderyka Chopina, Warsaw 1949, Plate PWM 239",
        "cover": "Chopin/19 Waltzes/waltzes.JPEG",
    },
}

# Covers for books that already exist in the registry.
EXISTING_BOOK_COVERS = {
    "czerny_op599": "Czerny/cover photo.jpg",
    "twenty_five_easy_etudes_op_100": "Burgmuller/copy_4BA32D77-FCB5-4C80-9BE1-C33FA292701E.JPEG",
}


def clementi_pieces():
    idx = 0
    for no, key, movements, blocked in CLEMENTI:
        for k, (start, roman, tempo) in enumerate(movements, 1):
            idx += 1
            yield {
                "collection": "clementi", "src": f"Clementi/Clementi sonatina No.{no}.musicxml",
                "start": start,
                "end": movements[k][0] if k < len(movements) else None,
                "slug": f"clementi_op36_{no}_{k}",
                "title": f"Sonatina in {key}, Op. 36 No. {no}",
                "subtitle": f"{roman}. {tempo}",
                "composer": "Muzio Clementi",
                "book": "clementi_op36", "book_index": idx,
                "work_title": f"Sonatina in {key}, Op. 36 No. {no}",
                "work_catalogue": f"Op. 36 No. {no}", "work_type": "sonata",
                "work_movements": len(movements), "work_index": k,
                "blocked": "D.C. al Fine — Phase-D" if blocked == k else None,
            }


def bach_pieces():
    for pos, (no, start, key, bwv) in enumerate(BACH_INVENTIONS):
        nxt = BACH_INVENTIONS[pos + 1][1] if pos + 1 < len(BACH_INVENTIONS) else None
        yield {
            "collection": "bach_inv",
            "src": "J.S.Bach/Two-Part Inventions/Bach Inventio 1-15.musicxml",
            "start": start, "end": nxt,
            "slug": f"bach_invention_{no}",
            "title": "Fifteen Two-Part Inventions",
            "subtitle": f"No. {no} in {key}, BWV {bwv}",
            "composer": "Johann Sebastian Bach",
            "book": "bach_inventions", "book_index": no,
            "work_title": f"Invention No. {no} in {key}, BWV {bwv}",
            "work_catalogue": f"BWV {bwv}", "work_type": "other",
            "work_movements": 1, "work_index": 1,
            "blocked": None,
        }


def hanon_pieces():
    for pos, start in enumerate(HANON_P1_STARTS):
        no = pos + 1
        nxt = HANON_P1_STARTS[pos + 1] if pos + 1 < len(HANON_P1_STARTS) else None
        part = hanon_book(no)
        yield {
            "collection": "hanon_p1",
            "src": "Hanon/The Virtuoso Pianist Part I/The Virtuoso-Pianist Hanon part 1.musicxml",
            "start": start, "end": nxt,
            "slug": f"hanon_virtuoso_{no}",
            "title": "The Virtuoso Pianist",
            "subtitle": f"No. {no}",
            "composer": "Charles-Louis Hanon",
            "book": f"hanon_{part}", "book_index": no,
            "work_title": None, "work_index": None,
            "blocked": None,
        }


def mozart_pieces():
    for k330_331, cfg in MOZART.items():
        movements = cfg["movements"]
        for k, (start, roman, tempo) in enumerate(movements, 1):
            end = movements[k][0] if k < len(movements) else cfg["end"]
            src = ("Mozart/Sonatas/Kv.330/Mozart Piano Sonata Kv.330.musicxml"
                   if k330_331 == "K330" else
                   "Mozart/Sonatas/Kv.331/Mozart Piano Sonata K.331.musicxml")
            yield {
                "collection": f"mozart_{k330_331.lower()}", "src": src,
                "start": start, "end": end,
                "slug": f"mozart_{k330_331.lower()}_mvt{k}",
                "title": cfg["title"], "subtitle": f"{roman}. {tempo}",
                "composer": "Wolfgang Amadeus Mozart",
                "book": None, "book_index": None,
                "work_title": cfg["title"],
                "work_catalogue": k330_331.replace("K", "K. "), "work_type": "sonata",
                "work_movements": 3, "work_index": k,
                # K.330 I already exists in the registry (MuseScore-sourced, validated):
                # replacing it is a pinned NEW VERSION decision, not a fresh upload.
                "blocked": ("duplicates published mozart_k330_mvt1 — founder call: "
                            "new version vs keep existing")
                           if k330_331 == "K330" and k == 1 else None,
            }


def chopin_pieces():
    for pos, (start, book_index, subtitle) in enumerate(CHOPIN_OP34):
        nxt = CHOPIN_OP34[pos + 1][0] if pos + 1 < len(CHOPIN_OP34) else None
        yield {
            "collection": "chopin_op34",
            "src": "Chopin/19 Waltzes/Op.34/Chopin Three Waltzes Op34.musicxml",
            "start": start, "end": nxt,
            "slug": f"chopin_waltz_op34_{pos + 1}",
            "title": "Trois Valses brillantes, Op. 34",
            "subtitle": subtitle,
            "composer": "Frédéric Chopin",
            "book": "chopin_waltzes", "book_index": book_index,
            "work_title": "Trois Valses brillantes, Op. 34",
            "work_catalogue": "Op. 34", "work_type": "collection",
            "work_movements": 3, "work_index": pos + 1,
            "blocked": None,
        }


def all_pieces():
    for gen in (clementi_pieces, bach_pieces, hanon_pieces, mozart_pieces, chopin_pieces):
        for p in gen():
            if not p.get("blocked") and p["slug"] in REVIEW_HOLDS:
                p["blocked"] = REVIEW_HOLDS[p["slug"]]
            yield p


if __name__ == "__main__":
    import collections
    rows = list(all_pieces())
    by = collections.Counter(r["collection"] for r in rows)
    blocked = [r for r in rows if r["blocked"]]
    print(f"total planned pieces: {len(rows)}")
    for k, v in by.items():
        print(f"  {k}: {v}")
    print(f"\nheld back: {len(blocked)}")
    for r in blocked:
        print(f"  {r['slug']}: {r['blocked']}")

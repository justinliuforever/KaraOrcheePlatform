#!/usr/bin/env python3
"""Extract a single preset from a SoundFont 2 file into a standalone .sf2.

Copies the full preset chain (preset zones -> instruments -> instrument zones
-> samples, including stereo-linked partners) byte-for-byte: all generators and
modulators are carried unchanged (only instrument/sample indices are rewritten),
so the extracted preset sounds identical to the source.

Usage:
  python3 extract_violin.py SOURCE.sf2 BANK PROGRAM OUTPUT.sf2 [--remap-to-program N] [--remap-to-bank N]

Example (FluidR3 Violin at bank 0 prog 40 -> standalone file exposing it at prog 0):
  python3 extract_violin.py FluidR3_GM.sf2 0 40 FluidR3_Violin.sf2 --remap-to-program 0
"""

import argparse
import struct
import sys

# ---------------------------------------------------------------------------
# Hydra record sizes (SoundFont 2.01/2.04 spec, section 7)
PHDR_SIZE = 38
BAG_SIZE = 4
MOD_SIZE = 10
GEN_SIZE = 4
INST_SIZE = 22
SHDR_SIZE = 46

GEN_INSTRUMENT = 41
GEN_SAMPLE_ID = 53

# shdr sampleType flags (monoSample=1, rightSample=2, leftSample=4, linkedSample=8; 0x8000 = ROM)
SAMPLE_TYPE_ROM = 0x8000

SAMPLE_PAD_POINTS = 46  # spec: minimum 46 zero sample points after each sample


# ---------------------------------------------------------------------------
# RIFF parsing

def parse_riff_chunks(data, start, end):
    """Yield (ckid, payload_start, payload_size) for chunks in data[start:end]."""
    pos = start
    while pos + 8 <= end:
        ckid = data[pos:pos + 4]
        (size,) = struct.unpack_from("<I", data, pos + 4)
        yield ckid, pos + 8, size
        pos += 8 + size + (size & 1)  # word-aligned


def parse_sf2(data):
    """Parse an sf2 file into a dict of raw sub-chunk payloads."""
    if data[0:4] != b"RIFF" or data[8:12] != b"sfbk":
        raise ValueError("not a RIFF sfbk (SoundFont 2) file")
    (riff_size,) = struct.unpack_from("<I", data, 4)
    out = {"info_chunks": [], "sdta_chunks": [], "pdta": {}}
    for ckid, cstart, csize in parse_riff_chunks(data, 12, 8 + riff_size):
        if ckid != b"LIST":
            continue
        list_type = data[cstart:cstart + 4]
        inner_start, inner_end = cstart + 4, cstart + csize
        for sid, sstart, ssize in parse_riff_chunks(data, inner_start, inner_end):
            payload = data[sstart:sstart + ssize]
            if list_type == b"INFO":
                out["info_chunks"].append((sid, payload))
            elif list_type == b"sdta":
                out["sdta_chunks"].append((sid, payload))
            elif list_type == b"pdta":
                out["pdta"][sid.decode("ascii")] = payload
    for req in ("phdr", "pbag", "pmod", "pgen", "inst", "ibag", "imod", "igen", "shdr"):
        if req not in out["pdta"]:
            raise ValueError(f"missing pdta sub-chunk: {req}")
    return out


# ---------------------------------------------------------------------------
# Hydra record decoding

def read_records(buf, size):
    return [buf[i:i + size] for i in range(0, len(buf) - len(buf) % size, size)]


def decode_phdr(rec):
    name = rec[0:20]
    preset, bank, bag_ndx = struct.unpack_from("<HHH", rec, 20)
    library, genre, morph = struct.unpack_from("<III", rec, 26)
    return {"name": name, "preset": preset, "bank": bank, "bag_ndx": bag_ndx,
            "library": library, "genre": genre, "morphology": morph}


def decode_bag(rec):
    gen_ndx, mod_ndx = struct.unpack("<HH", rec)
    return {"gen_ndx": gen_ndx, "mod_ndx": mod_ndx}


def decode_gen(rec):
    oper, amount = struct.unpack("<HH", rec)
    return {"oper": oper, "amount": amount}


def decode_inst(rec):
    name = rec[0:20]
    (bag_ndx,) = struct.unpack_from("<H", rec, 20)
    return {"name": name, "bag_ndx": bag_ndx}


def decode_shdr(rec):
    name = rec[0:20]
    start, end, startloop, endloop, rate = struct.unpack_from("<IIIII", rec, 20)
    pitch, corr = struct.unpack_from("<Bb", rec, 40)
    link, stype = struct.unpack_from("<HH", rec, 42)
    return {"name": name, "start": start, "end": end, "startloop": startloop,
            "endloop": endloop, "rate": rate, "pitch": pitch, "corr": corr,
            "link": link, "type": stype}


# ---------------------------------------------------------------------------
# Extraction

def collect_zone_span(bags, next_bag_ndx_records, idx, gen_records, mod_records):
    """Return (gen slice indices, mod slice indices) for bag zone idx."""
    g0 = bags[idx]["gen_ndx"]
    m0 = bags[idx]["mod_ndx"]
    g1 = bags[idx + 1]["gen_ndx"] if idx + 1 < len(bags) else len(gen_records)
    m1 = bags[idx + 1]["mod_ndx"] if idx + 1 < len(bags) else len(mod_records)
    return (g0, g1), (m0, m1)


def extract(data, bank, program, remap_bank=None, remap_program=None, verbose=True):
    sf = parse_sf2(data)
    pdta = sf["pdta"]

    phdr = [decode_phdr(r) for r in read_records(pdta["phdr"], PHDR_SIZE)]
    pbag = [decode_bag(r) for r in read_records(pdta["pbag"], BAG_SIZE)]
    pmod = read_records(pdta["pmod"], MOD_SIZE)
    pgen = read_records(pdta["pgen"], GEN_SIZE)
    inst = [decode_inst(r) for r in read_records(pdta["inst"], INST_SIZE)]
    ibag = [decode_bag(r) for r in read_records(pdta["ibag"], BAG_SIZE)]
    imod = read_records(pdta["imod"], MOD_SIZE)
    igen = read_records(pdta["igen"], GEN_SIZE)
    shdr = [decode_shdr(r) for r in read_records(pdta["shdr"], SHDR_SIZE)]

    # sdta: FluidR3 has a single smpl chunk (16-bit). sm24 unsupported (rare).
    smpl = None
    for sid, payload in sf["sdta_chunks"]:
        if sid == b"smpl":
            smpl = payload
        elif sid == b"sm24":
            raise ValueError("sm24 (24-bit) sample chunk not supported")
    if smpl is None:
        raise ValueError("no sdta smpl chunk")

    # --- locate the preset (skip terminal EOP record) ---
    target = None
    target_i = None
    for i, p in enumerate(phdr[:-1]):
        if p["bank"] == bank and p["preset"] == program:
            target, target_i = p, i
            break
    if target is None:
        raise ValueError(f"preset bank={bank} program={program} not found")
    pname = target["name"].split(b"\x00")[0].decode("ascii", "replace")
    if verbose:
        print(f"source preset: '{pname}' bank={bank} prog={program} (phdr index {target_i})")

    # --- preset zones ---
    pz_start = target["bag_ndx"]
    pz_end = phdr[target_i + 1]["bag_ndx"]
    preset_zones = []      # list of (gen bytes list, mod bytes list, inst_id or None)
    needed_insts = []      # source instrument ids, order of first reference
    for z in range(pz_start, pz_end):
        (g0, g1), (m0, m1) = collect_zone_span(pbag, None, z, pgen, pmod)
        gens = pgen[g0:g1]
        mods = pmod[m0:m1]
        inst_id = None
        for g in gens:
            d = decode_gen(g)
            if d["oper"] == GEN_INSTRUMENT:
                inst_id = d["amount"]
        if inst_id is not None and inst_id not in needed_insts:
            needed_insts.append(inst_id)
        preset_zones.append((gens, mods, inst_id))
    if verbose:
        print(f"preset zones: {len(preset_zones)}, instruments referenced: {needed_insts}")

    # --- instrument zones, collect samples ---
    inst_zone_map = {}     # src inst id -> list of (gens, mods, sample_id or None)
    needed_samples = []    # source sample ids, order of first reference
    for iid in needed_insts:
        if iid >= len(inst) - 1:
            raise ValueError(f"instrument index {iid} out of range")
        iz_start = inst[iid]["bag_ndx"]
        iz_end = inst[iid + 1]["bag_ndx"]
        zones = []
        for z in range(iz_start, iz_end):
            (g0, g1), (m0, m1) = collect_zone_span(ibag, None, z, igen, imod)
            gens = igen[g0:g1]
            mods = imod[m0:m1]
            samp_id = None
            for g in gens:
                d = decode_gen(g)
                if d["oper"] == GEN_SAMPLE_ID:
                    samp_id = d["amount"]
            if samp_id is not None and samp_id not in needed_samples:
                needed_samples.append(samp_id)
            zones.append((gens, mods, samp_id))
        inst_zone_map[iid] = zones

    # --- stereo-linked partners (transitively) ---
    queue = list(needed_samples)
    while queue:
        sid = queue.pop(0)
        s = shdr[sid]
        stype = s["type"] & ~SAMPLE_TYPE_ROM
        if stype in (2, 4, 8):  # right / left / linked
            link = s["link"]
            if link < len(shdr) - 1 and link not in needed_samples:
                needed_samples.append(link)
                queue.append(link)
    if verbose:
        print(f"samples needed (incl. stereo links): {len(needed_samples)}")

    # --- build new smpl data ---
    samp_remap = {}  # src sample id -> new sample id
    new_shdr_entries = []
    smpl_parts = []
    cursor = 0  # in sample points (16-bit words)
    pad = b"\x00\x00" * SAMPLE_PAD_POINTS
    for new_id, sid in enumerate(needed_samples):
        samp_remap[sid] = new_id
    for sid in needed_samples:
        s = shdr[sid]
        if s["type"] & SAMPLE_TYPE_ROM:
            raise ValueError(f"ROM sample {sid} not supported")
        raw = smpl[s["start"] * 2:s["end"] * 2]
        n_points = s["end"] - s["start"]
        new_start = cursor
        new_entry = dict(s)
        new_entry["start"] = new_start
        new_entry["end"] = new_start + n_points
        new_entry["startloop"] = new_start + (s["startloop"] - s["start"])
        new_entry["endloop"] = new_start + (s["endloop"] - s["start"])
        stype = s["type"] & ~SAMPLE_TYPE_ROM
        if stype in (2, 4, 8):
            if s["link"] in samp_remap:
                new_entry["link"] = samp_remap[s["link"]]
            else:  # dangling link in source; degrade to mono to stay valid
                new_entry["link"] = 0
                new_entry["type"] = 1
        smpl_parts.append(raw)
        smpl_parts.append(pad)
        cursor += n_points + SAMPLE_PAD_POINTS
        new_shdr_entries.append(new_entry)
    new_smpl = b"".join(smpl_parts)

    # --- rebuild hydra ---
    inst_remap = {iid: k for k, iid in enumerate(needed_insts)}

    # igen/imod/ibag
    out_igen, out_imod, out_ibag = [], [], []
    inst_records = []
    for iid in needed_insts:
        inst_records.append((inst[iid]["name"], len(out_ibag)))
        for gens, mods, samp_id in inst_zone_map[iid]:
            out_ibag.append((len(out_igen), len(out_imod)))
            for g in gens:
                d = decode_gen(g)
                if d["oper"] == GEN_SAMPLE_ID:
                    g = struct.pack("<HH", GEN_SAMPLE_ID, samp_remap[d["amount"]])
                out_igen.append(g)
            out_imod.extend(mods)

    # pgen/pmod/pbag
    out_pgen, out_pmod, out_pbag = [], [], []
    for gens, mods, inst_id in preset_zones:
        out_pbag.append((len(out_pgen), len(out_pmod)))
        for g in gens:
            d = decode_gen(g)
            if d["oper"] == GEN_INSTRUMENT:
                g = struct.pack("<HH", GEN_INSTRUMENT, inst_remap[d["amount"]])
            out_pgen.append(g)
        out_pmod.extend(mods)

    out_bank = bank if remap_bank is None else remap_bank
    out_prog = program if remap_program is None else remap_program

    # --- serialize hydra chunks (with terminal records) ---
    def phdr_bytes():
        b = bytearray()
        b += target["name"].ljust(20, b"\x00")[:20]
        b += struct.pack("<HHHIII", out_prog, out_bank, 0,
                         target["library"], target["genre"], target["morphology"])
        b += b"EOP".ljust(20, b"\x00")
        b += struct.pack("<HHHIII", 0, 0, len(out_pbag), 0, 0, 0)
        return bytes(b)

    def bag_bytes(bags, n_gen, n_mod):
        b = bytearray()
        for g, m in bags:
            b += struct.pack("<HH", g, m)
        b += struct.pack("<HH", n_gen, n_mod)  # terminal
        return bytes(b)

    def inst_bytes():
        b = bytearray()
        for name, bag_ndx in inst_records:
            b += name.ljust(20, b"\x00")[:20] + struct.pack("<H", bag_ndx)
        b += b"EOI".ljust(20, b"\x00") + struct.pack("<H", len(out_ibag))
        return bytes(b)

    def shdr_bytes():
        b = bytearray()
        for s in new_shdr_entries:
            b += s["name"].ljust(20, b"\x00")[:20]
            b += struct.pack("<IIIII", s["start"], s["end"], s["startloop"],
                             s["endloop"], s["rate"])
            b += struct.pack("<Bb", s["pitch"], s["corr"])
            b += struct.pack("<HH", s["link"], s["type"])
        b += b"EOS".ljust(20, b"\x00") + b"\x00" * 26
        return bytes(b)

    def gens_mods_bytes(records, terminal_size):
        return b"".join(records) + b"\x00" * terminal_size

    hydra = {
        "phdr": phdr_bytes(),
        "pbag": bag_bytes(out_pbag, len(out_pgen), len(out_pmod)),
        "pmod": gens_mods_bytes(out_pmod, MOD_SIZE),
        "pgen": gens_mods_bytes(out_pgen, GEN_SIZE),
        "inst": inst_bytes(),
        "ibag": bag_bytes(out_ibag, len(out_igen), len(out_imod)),
        "imod": gens_mods_bytes(out_imod, MOD_SIZE),
        "igen": gens_mods_bytes(out_igen, GEN_SIZE),
        "shdr": shdr_bytes(),
    }

    # --- INFO: carry source INFO, adjust INAM, add ICMT provenance ---
    info_chunks = []
    src_name = None
    for sid, payload in sf["info_chunks"]:
        if sid == b"INAM":
            src_name = payload.rstrip(b"\x00").decode("latin-1")
            continue
        if sid == b"ICMT":
            continue  # replaced below
        info_chunks.append((sid, payload))
    new_name = f"{pname} (from {src_name or 'unknown'})"[:255]
    comment = (f"Subset of '{src_name or 'unknown'}': preset '{pname}' "
               f"(bank {bank} prog {program}) exposed at bank {out_bank} prog {out_prog}. "
               f"Samples/generators/modulators copied unchanged.")
    info_chunks.insert(1 if info_chunks and info_chunks[0][0] == b"ifil" else 0,
                       (b"INAM", new_name.encode("latin-1")))
    info_chunks.append((b"ICMT", comment.encode("latin-1")))

    return build_sf2(info_chunks, new_smpl, hydra), {
        "preset_name": pname,
        "n_preset_zones": len(preset_zones),
        "n_instruments": len(needed_insts),
        "n_inst_zones": len(out_ibag),
        "n_samples": len(needed_samples),
        "smpl_bytes": len(new_smpl),
        "out_bank": out_bank,
        "out_prog": out_prog,
    }


# ---------------------------------------------------------------------------
# RIFF writing

def _chunk(ckid, payload):
    if isinstance(payload, str):
        payload = payload.encode("ascii")
    if len(payload) % 2:
        payload += b"\x00"  # zero-terminate/word-align (RIFF pad byte)
    return ckid + struct.pack("<I", len(payload)) + payload


def _zstr(payload):
    """INFO strings must be zero-terminated with even byte count."""
    payload = payload.rstrip(b"\x00")
    payload += b"\x00" if len(payload) % 2 else b"\x00\x00"
    return payload


def build_sf2(info_chunks, smpl_data, hydra):
    info_body = b"INFO"
    for sid, payload in info_chunks:
        if sid == b"ifil" or sid == b"iver":
            info_body += _chunk(sid, payload)  # fixed 4-byte struct, no zstr
        else:
            info_body += _chunk(sid, _zstr(payload))
    sdta_body = b"sdta" + _chunk(b"smpl", smpl_data)
    pdta_body = b"pdta"
    for sid in ("phdr", "pbag", "pmod", "pgen", "inst", "ibag", "imod", "igen", "shdr"):
        pdta_body += _chunk(sid.encode(), hydra[sid])
    payload = b"sfbk" + _chunk(b"LIST", info_body) + _chunk(b"LIST", sdta_body) + _chunk(b"LIST", pdta_body)
    return b"RIFF" + struct.pack("<I", len(payload)) + payload


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Extract one preset from an .sf2 into a standalone .sf2")
    ap.add_argument("source", help="source .sf2 path")
    ap.add_argument("bank", type=int, help="source bank number")
    ap.add_argument("program", type=int, help="source program (preset) number")
    ap.add_argument("output", help="output .sf2 path")
    ap.add_argument("--remap-to-program", type=int, default=None,
                    help="program number for the preset in the output (default: keep source)")
    ap.add_argument("--remap-to-bank", type=int, default=None,
                    help="bank number for the preset in the output (default: keep source)")
    args = ap.parse_args()

    with open(args.source, "rb") as f:
        data = f.read()
    out, stats = extract(data, args.bank, args.program,
                         remap_bank=args.remap_to_bank,
                         remap_program=args.remap_to_program)
    with open(args.output, "wb") as f:
        f.write(out)
    print(f"wrote {args.output}: {len(out):,} bytes "
          f"({stats['n_instruments']} instrument(s), {stats['n_samples']} sample(s), "
          f"preset '{stats['preset_name']}' at bank {stats['out_bank']} prog {stats['out_prog']})")


if __name__ == "__main__":
    main()

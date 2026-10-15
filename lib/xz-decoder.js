/**
 * lib/xz-decoder.js — Minimal XZ (LZMA2) decompressor (shared utility)
 * Zero-dependency decoder for the .xz streams embedded in MoTeC M1 packages.
 * Supports single-filter LZMA2 blocks, which is what xz-utils produces by default.
 * Integrity checks (CRC32/CRC64/SHA-256) are skipped, not verified.
 */

var XZ_MAGIC = [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00];

/** Find the next XZ stream header at or after `from`. Returns -1 if none. */
function xzFindStream(bytes, from) {
    for (var i = from || 0; i <= bytes.length - 6; i++) {
        if (bytes[i] !== 0xFD) continue;
        var hit = true;
        for (var k = 1; k < 6; k++) { if (bytes[i + k] !== XZ_MAGIC[k]) { hit = false; break; } }
        if (hit) return i;
    }
    return -1;
}

/** Decompress the XZ stream starting at `offset` in `bytes` (Uint8Array). Returns a Uint8Array. */
function xzDecompress(bytes, offset) {
    var p = offset || 0;
    for (var k = 0; k < 6; k++) { if (bytes[p + k] !== XZ_MAGIC[k]) throw new Error('Not an XZ stream'); }
    var checkType = bytes[p + 7] & 0x0F;
    var checkSize = checkType === 0 ? 0 : 4 << ((checkType - 1) / 3 | 0);
    p += 12;

    var out = new XzOutput();
    // Blocks run until the index indicator (0x00)
    while (bytes[p] !== 0x00) {
        var headerSize = (bytes[p] + 1) * 4, h = p + 1, flags = bytes[h++];
        if ((flags & 0x03) !== 0) throw new Error('XZ: only single-filter blocks are supported');
        if (flags & 0x40) h = xzSkipVarint(bytes, h);   // compressed size
        if (flags & 0x80) h = xzSkipVarint(bytes, h);   // uncompressed size
        if (bytes[h] !== 0x21) throw new Error('XZ: unsupported filter 0x' + bytes[h].toString(16));
        p += headerSize;
        var start = p;
        p = lzma2Decode(bytes, p, out);
        while ((p - start) % 4) p++;                     // block padding
        p += checkSize;
    }
    return out.result();
}

function xzSkipVarint(bytes, p) {
    while (bytes[p++] & 0x80) { /* continue */ }
    return p;
}

/** Growable output buffer that also serves as the LZMA dictionary. */
function XzOutput() {
    this.buf = new Uint8Array(1 << 20);
    this.pos = 0;
}
XzOutput.prototype.reserve = function (n) {
    if (this.pos + n <= this.buf.length) return;
    var size = this.buf.length;
    while (size < this.pos + n) size *= 2;
    var next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
};
XzOutput.prototype.result = function () { return this.buf.slice(0, this.pos); };

// =========================================================================
// LZMA2 chunk layer
// =========================================================================

function lzma2Decode(bytes, p, out) {
    var lz = new LzmaDecoder(out);
    for (;;) {
        var ctrl = bytes[p++];
        if (ctrl === 0x00) return p;
        if (ctrl === 0x01 || ctrl === 0x02) {            // uncompressed chunk
            var size = ((bytes[p] << 8) | bytes[p + 1]) + 1;
            p += 2;
            out.reserve(size);
            out.buf.set(bytes.subarray(p, p + size), out.pos);
            out.pos += size; p += size;
            continue;
        }
        if (ctrl < 0x80) throw new Error('XZ: bad LZMA2 control byte 0x' + ctrl.toString(16));
        var unpacked = ((ctrl & 0x1F) << 16) + (bytes[p] << 8) + bytes[p + 1] + 1;
        var packed = (bytes[p + 2] << 8) + bytes[p + 3] + 1;
        p += 4;
        var reset = (ctrl >> 5) & 0x03;
        if (reset >= 2) lz.setProps(bytes[p++]);
        if (reset >= 1) lz.resetState();
        lz.decodeChunk(bytes, p, unpacked);
        p += packed;
    }
}

// =========================================================================
// LZMA decoder
// =========================================================================

function LzmaDecoder(out) {
    this.out = out;
    this.lc = 0; this.lp = 0; this.pb = 0;
    this.literal = null;
}

LzmaDecoder.prototype.setProps = function (d) {
    this.lc = d % 9; d = d / 9 | 0;
    this.lp = d % 5; this.pb = d / 5 | 0;
    if (this.lc + this.lp > 4) throw new Error('XZ: invalid LZMA2 properties');
};

LzmaDecoder.prototype.resetState = function () {
    var p = function (n) { var a = new Uint16Array(n); a.fill(1024); return a; };
    this.literal = p(0x300 << (this.lc + this.lp));
    this.isMatch = p(192); this.isRep = p(12); this.isRepG0 = p(12);
    this.isRepG1 = p(12); this.isRepG2 = p(12); this.isRep0Long = p(192);
    this.posSlot = p(256); this.posSpecial = p(115); this.align = p(16);
    this.lenProbs = p(514); this.repLenProbs = p(514);   // choice, choice2, low[16x8], mid[16x8], high[256]
    this.state = 0;
    this.rep0 = 0; this.rep1 = 0; this.rep2 = 0; this.rep3 = 0;
};

LzmaDecoder.prototype.decodeChunk = function (bytes, p, unpacked) {
    var range = 0xFFFFFFFF, code = 0;
    p++;                                                  // first range-coder byte is always 0
    for (var i = 0; i < 4; i++) code = ((code << 8) | bytes[p++]) >>> 0;

    function bit(probs, i) {
        var prob = probs[i], bound = (range >>> 11) * prob, b;
        if (code < bound) { range = bound; probs[i] = prob + ((2048 - prob) >> 5); b = 0; }
        else { range -= bound; code -= bound; probs[i] = prob - (prob >> 5); b = 1; }
        if (range < 0x1000000) { range = (range * 256) >>> 0; code = ((code << 8) | bytes[p++]) >>> 0; }
        return b;
    }
    function tree(probs, base, numBits) {
        var m = 1;
        for (var i = 0; i < numBits; i++) m = (m << 1) | bit(probs, base + m);
        return m - (1 << numBits);
    }
    function reverseTree(probs, base, numBits) {
        var m = 1, sym = 0;
        for (var i = 0; i < numBits; i++) { var b = bit(probs, base + m); m = (m << 1) | b; sym |= b << i; }
        return sym;
    }
    function direct(numBits) {
        var res = 0;
        for (var i = 0; i < numBits; i++) {
            range >>>= 1;
            var b = code >= range ? 1 : 0;
            if (b) code -= range;
            res = ((res << 1) | b) >>> 0;
            if (range < 0x1000000) { range = (range * 256) >>> 0; code = ((code << 8) | bytes[p++]) >>> 0; }
        }
        return res;
    }
    function length(probs, posState) {
        if (bit(probs, 0) === 0) return tree(probs, 2 + posState * 8, 3);
        if (bit(probs, 1) === 0) return 8 + tree(probs, 130 + posState * 8, 3);
        return 16 + tree(probs, 258, 8);
    }

    var out = this.out, lc = this.lc, lpMask = (1 << this.lp) - 1, pbMask = (1 << this.pb) - 1;
    var lit = this.literal, state = this.state;
    var rep0 = this.rep0, rep1 = this.rep1, rep2 = this.rep2, rep3 = this.rep3;
    out.reserve(unpacked);
    var buf = out.buf, pos = out.pos, end = pos + unpacked;

    while (pos < end) {
        var posState = pos & pbMask;
        if (bit(this.isMatch, (state << 4) + posState) === 0) {
            var prev = pos > 0 ? buf[pos - 1] : 0;
            var base = 0x300 * (((pos & lpMask) << lc) + (prev >> (8 - lc)));
            var sym = 1;
            if (state >= 7) {
                var matchByte = buf[pos - rep0 - 1];
                while (sym < 0x100) {
                    var mb = (matchByte >> 7) & 1;
                    matchByte <<= 1;
                    var b = bit(lit, base + ((1 + mb) << 8) + sym);
                    sym = (sym << 1) | b;
                    if (mb !== b) break;
                }
            }
            while (sym < 0x100) sym = (sym << 1) | bit(lit, base + sym);
            buf[pos++] = sym & 0xFF;
            state = state < 4 ? 0 : (state < 10 ? state - 3 : state - 6);
            continue;
        }

        var len;
        if (bit(this.isRep, state) === 0) {
            rep3 = rep2; rep2 = rep1; rep1 = rep0;
            len = length(this.lenProbs, posState);
            state = state < 7 ? 7 : 10;
            var slot = tree(this.posSlot, (len < 3 ? len : 3) << 6, 6);
            if (slot < 4) {
                rep0 = slot;
            } else {
                var nd = (slot >> 1) - 1, dist = ((2 | (slot & 1)) << nd) >>> 0;
                if (slot < 14) {
                    dist += reverseTree(this.posSpecial, dist - slot, nd);
                } else {
                    dist += direct(nd - 4) * 16;
                    dist += reverseTree(this.align, 0, 4);
                }
                rep0 = dist >>> 0;
                if (rep0 === 0xFFFFFFFF) break;           // end marker
            }
        } else {
            if (bit(this.isRepG0, state) === 0) {
                if (bit(this.isRep0Long, (state << 4) + posState) === 0) {
                    state = state < 7 ? 9 : 11;
                    buf[pos] = buf[pos - rep0 - 1]; pos++;
                    continue;
                }
            } else {
                var d;
                if (bit(this.isRepG1, state) === 0) d = rep1;
                else {
                    if (bit(this.isRepG2, state) === 0) d = rep2;
                    else { d = rep3; rep3 = rep2; }
                    rep2 = rep1;
                }
                rep1 = rep0; rep0 = d;
            }
            len = length(this.repLenProbs, posState);
            state = state < 7 ? 8 : 11;
        }

        len += 2;
        if (rep0 >= pos) throw new Error('XZ: corrupt data (distance out of range)');
        if (len > end - pos) len = end - pos;
        for (var j = 0; j < len; j++) { buf[pos] = buf[pos - rep0 - 1]; pos++; }
    }

    out.pos = pos;
    this.state = state;
    this.rep0 = rep0; this.rep1 = rep1; this.rep2 = rep2; this.rep3 = rep3;
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { xzDecompress: xzDecompress, xzFindStream: xzFindStream };
}

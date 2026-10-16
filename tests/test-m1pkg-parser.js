/**
 * test-m1pkg-parser.js — Unit tests for lib/xz-decoder.js and lib/m1pkg-parser.js.
 * Uses a synthetic .m1pkg built in-test (real packages are not committed).
 */

// Fixtures generated with Python's lzma module (xz-utils compatible).
var M1PKG_FIXTURES = {
  tuneConfigXz: '/Td6WFoAAAFpIt42AgAhARYAAAB0L+Wj4AdEAqddAB4Py4cR2M5mkQ+DHsr9ezPUf+m32+OpcTR59tCF07RwirxB9MtEFGD9rvEZGonRGy1A/SRUYNrY1hHFMZJXrtrLL9Ycx6FLUCXRaVWgLp43l+HSLrFvua2FGV3eakBHZOQ9x0cy4Ymx8JmHfZoLdpKnNfEao0PadRodr5KdF2BmGIjkzgXrfFuvve+62ehMyWDyNKBIvfHLkhhqdZt79lPVnhy0bTuSrEI+juxjt/hG/Ps2F/cAxPPP0Ba5tK4Ac2kRCAGh41qSnDNfhJhaA30TvOk5hTU+kOtKQn9ZzspkggPjq3oW3DOlxvVFikm8oO0mPE/DV1BzOxO2svD+NgYcvfZJmXXe+J2N1C8suexWkn+atXwhI90x2CV5nc/iqdloCOx16oMUt/plXckhmjEUHdOsWJMytyfA25dcD0qxbqHzRA+ad9OINk69BXSNyNYAmCQnRfnvQHImd2uCNAUtAplv3Nq5Z1eEwa99OwjvVZUIBWZ5CyxJjBu1LCN2c3yWoFFpx8H76PH+9F4+C+e2Z0/v6giDCc46Qgy42f005H4XPhaUF9q2GVvOlyPGSGm38AWMmeb4YxCaqPyvfWuo9nnsw3EA8Uj2oScDVkttJrHWxV0El9TKoaAh54oxT07fAU+q8W1hZF8eMvndfAlmJA+o7pz3gsyWQVQWEHuvKBJQDENjNGng+4G6Rq0THx83HHeMxq0C8qtp8HeQm57aGW3i9H8GuUceFltd/+4TXb1lxJEP0lYl27zTDw9T5lmmVd/AmaoHXgfUf6LOAs5Q0/9ILHKbM7mz/AwXh76y5GtWYv5jmJMe/MD5U6WsRiyrzcD/h2Ozodw1oZj+WYVRl5gfkfc9huXgn1cL77hydLc8bxsg1JUZWcZEwhuYvOeNlIJovcIAAF2ZcA8AAb8FxQ4AADPJJKs+MA2LAgAAAAABWVo=',
  randomXz: '/Td6WFoAAATm1rRGAgAhARYAAAB0L+WjAQEr3ARlqh+tHVra5awbHl8TcHls/RD/Ga9gHQSstB0CK0Z4czry31+utwhZ0e45EMtIlbXMiSkR/wa2Yi7fPPk1/UuUKMoJfESzAl6WX7PqbazULYFuaa/g5odMnATn0jZdLGDJ6vR59oag65Mm5GIS1Q3Ls3cVamo6aLqO23QIRp7zzrMK+NDdaLv4X/ok8tL8GIf7XIe6tDgypZsbPRB893jWf+Jt+BGRKX6TlcsSxVfOWvHUFhjXGbwEW36ZZfGilHHEKqxqqTjEdcetMjgCHwU7LJka/OsV3s9ouuB8vNYelxuaC52+l2PTkvyv36KMlyNFYuvdB2Vw/1iJas/3yu4/HOnkCmjl3pONOJx9vddbCdTn4jNEP0qMxKGQ1ri43GFf0Y4ovlkOqlAbAK4c589tVBe8AAHEAqwCAADMqdU3scRn+wIAAAAABFla',
  textXz: '/Td6WFoAAAD/EtlBAgAhARYAAAB0L+Wj4E6gAwhdACMdSKbrgXHAJOGVtCoTeBCEnGSLqsRJn7z2NujEzlXaaD1gYyoIsQz/Y5hooLNs+7rW2zifAHSXxs1lUxJaOkYTlwaaqkSLsvsRNVfw+Cs00ukjihPSP04BgxJRgcUhZBLSrnOc0gb7o3ydPHRKyi2anWqsCqdqxfg0cL+roPiGaocnBBsjg8nT7l4BItg0RsvJIT0EaD+JSZ0WNh5r3D2vsndbYJd8Y5TpN9q/suE6h9hEK6pXJYgQ8L4MJycP4tRSzcM3w9NDzTD8sU4aVjkxvlbZi4IELgGc+gQNKqORtGcQPhXJNIkGaEyVD6xEcWkC6cFy+ib95KqS+6YDZxufy3lJICr7TC+LJAyaRk1U7Ch8FBYBfHv8EflytAYsBMYpSw+C6xsIJDrVrVgjoFcYFUnM1LMFpGiNSJ4A7gFzgtEkwfRCDtJk7hn+4esfUUiAKCFFIs1wDfK2hxo3Sv1Dcmd0A9u++SdhgM5s/s/B7WOtA3BMxWUF81SerptGatacO7j65tGFdULAz1EbSd2QMilGzgYNzqrtM7RSDMiqlFp90e0o2xbmRPb8N5Sdz9IHshCLBgcCIDX0czSnFHEjFlpwiNxrRJ2AJaXAc5FMQ/2Fdm14NHA6gulOIYrFToFC45U7PXf+Z+55Plnb+JbMbx/Ic8ULbFAhMSjP4P77Pc6O7/mmmv7Re8bC4ikBw6Vwx6qBvmaLhXncdiD4E8PAc/cwGputPgqBdkIjFYLUmh3V7QrZ8CgH2J6kjv4MvHog/Sj9zOUsJWPURBRPdYO0AuQVY1uhflzyyi0VH9jvlgrhOa6lkhudlNlEj7mobKnFBM8U1MIDKhAZSbUH3K2gIQGN7p4k393g0CQbUdg3nfBj9r5W9roQoqkTHsT1YfZ/vnUNbeiedveb7NsaPRN8bUNZRUgQIftCLzR2v8C3pGTuSzZM9HC/8W93aR2OYN1mdY8eSqDLUW+qtLMRik5Mdk6LZ4F+0KYuUD+1Fro5eldmrYWlt2cd561pVtAtjS0SCwY3PrB8AAABnAahnQEAx5O2P6gACvwCAAAAAABZWg==',
  textLen: 20129
};

function m1tFromBase64(s) {
  var bin = atob(s), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- Synthetic package builder (mirrors the Mo node layout) ----

function m1tConcat(parts) {
  var len = 0, off = 0;
  parts.forEach(function (p) { len += p.length; });
  var out = new Uint8Array(len);
  parts.forEach(function (p) { out.set(p, off); off += p.length; });
  return out;
}

function m1tNode(flags, a, b, tag, payload) {
  var padded = (payload.length + 3) & ~3, out = new Uint8Array(12 + padded);
  out.set([0x4D, 0x6F, flags >> 8, flags & 255, a, b, tag >> 8, tag & 255]);
  new DataView(out.buffer).setUint32(8, payload.length, false);
  out.set(payload, 12);
  return out;
}

function m1tStr(s, flags) {
  var bytes = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return m1tNode(flags || 0, 0, 1, 0, bytes);
}

function m1tInt(v) { return m1tNode(0, 1, 1, 8, new Uint8Array([2, v & 255, (v >> 8) & 255, (v >> 16) & 255, 0])); }

function m1tTime(y, mo, d, h, mi, s) {
  var b = new Uint8Array(16), dv = new DataView(b.buffer);
  [y, mo, 0, d, h, mi, s, 0].forEach(function (v, i) { dv.setUint16(i * 2, v, true); });
  return m1tNode(0, 0, 1, 7, b);
}

function m1tKv(key, valueNode) { return m1tNode(0, 1, 0, 10, m1tConcat([m1tStr(key), valueNode])); }

function m1tList(nodes) { return m1tNode(0, 1, 0, 9, m1tConcat(nodes)); }

/** Calibration image: speed limit, polarity, 3x2 table, X/Y axes, 5-word IO resource. */
function m1tImage(opts) {
  var img = new Uint8Array(0x48), dv = new DataView(img.buffer);
  dv.setFloat32(0x00, opts.limit, false);
  dv.setUint32(0x04, opts.polarity, false);
  opts.body.forEach(function (v, i) { dv.setFloat32(0x08 + i * 4, v, false); });
  [0, 6000, 6000].forEach(function (v, i) { dv.setFloat32(0x20 + i * 4, v, false); });
  [0, 100000].forEach(function (v, i) { dv.setFloat32(0x2C + i * 4, v, false); });
  dv.setUint32(0x34 + 8, opts.pin, false);
  return img;
}

/** Split the image into two security-group chunks inside a calibration copy container. */
function m1tCalCopy(tag, img) {
  function chunk(group, start, data) {
    var hdr = new Uint8Array(68);
    new DataView(hdr.buffer).setUint32(0, start, false);
    return m1tNode(group << 8, 2, 0, 10, m1tConcat([m1tNode(0, 2, 1, 10, hdr), m1tNode(0, 0, 1, 7, data)]));
  }
  return m1tNode(0, 2, 0, tag, m1tConcat([chunk(12, 0, img.subarray(0, 0x20)), chunk(13, 0x20, img.subarray(0x20))]));
}

function m1tPackage(opts) {
  var meta = m1tList([
    m1tKv('project.name', m1tStr('Test Firmware')),
    m1tKv('Summary.Firmware', m1tStr('Test Firmware')),
    m1tKv('Summary.Firmware Version', m1tStr('01.00.0002')),
    m1tKv('Summary.Comment', m1tStr(opts.name)),
    m1tKv('comment.log', m1tNode(0, 1, 0, 21, m1tNode(0, 1, 0, 22, m1tConcat([
      m1tTime(2026, 10, 15, 20, 51, 5), m1tStr(opts.name), m1tStr('a note', 0x100)])))),
    m1tKv('modified.utc', m1tTime(2026, 10, 15, 20, 51, 6)),
    m1tKv('pkg.calibrations', m1tList([
      m1tKv('Fuel.Injector.Primary.Calibration.Proxy', m1tStr(opts.injector)),
      m1tKv('Fuel.Properties.Calibration.Proxy', m1tStr('Gasoline 98 Octane.1.0'))])),
    m1tKv('device.serialnum', m1tInt(30924))
  ]);
  var baseline = m1tImage({ limit: 42000, polarity: 0, body: [1, 1, 1, 1, 1, 1], pin: 0 });
  var root = m1tConcat([
    meta,
    m1tNode(0, 1, 0, 12, m1tConcat([m1tCalCopy(65, baseline), m1tCalCopy(7, m1tImage(opts))])),
    m1tNode(0, 0, 1, 7, m1tFromBase64(M1PKG_FIXTURES.tuneConfigXz))
  ]);
  return m1tNode(0, 1, 0, 14, root);
}

var M1T_V1 = { name: 'Tune V1', limit: 42000, polarity: 0, body: [0.5, 0.6, 0.7, 0.8, 0.9, 1.0], pin: 0, injector: 'Bosch 980.1.0' };
var M1T_V2 = { name: 'Tune V2', limit: 45000, polarity: 1, body: [0.5, 0.6, 0.75, 0.8, 0.9, 1.0], pin: 0x652a, injector: 'Injector Dynamics ID850.1.0' };

function m1tFind(pkg, name) {
  return pkg.items.filter(function (i) { return i.name === name; })[0];
}

describe('XZ decoder — xzDecompress', function () {

  it('decodes an LZMA2 stream with matches and repeat distances', function () {
    var out = xzDecompress(m1tFromBase64(M1PKG_FIXTURES.textXz), 0);
    assert.equal(out.length, M1PKG_FIXTURES.textLen);
    var text = String.fromCharCode.apply(null, out.subarray(0, 60));
    assert.ok(text.indexOf('Fuel.Cylinder 0.Trim=0;Ignition.Cylinder 0.Trim=0;') === 0, text);
  });

  it('decodes uncompressed LZMA2 chunks (incompressible data)', function () {
    var out = xzDecompress(m1tFromBase64(M1PKG_FIXTURES.randomXz), 0), x = 12345;
    assert.equal(out.length, 300);
    for (var i = 0; i < 300; i++) {
      x = (Math.imul(x, 1103515245) + 12345) & 0x7FFFFFFF;
      assert.equal(out[i], (x >> 16) & 255, 'byte ' + i);
    }
  });

  it('finds embedded streams and rejects non-XZ data', function () {
    var data = m1tConcat([new Uint8Array([1, 2, 3]), m1tFromBase64(M1PKG_FIXTURES.textXz)]);
    assert.equal(xzFindStream(data, 0), 3);
    assert.equal(xzFindStream(new Uint8Array(10), 0), -1);
    assert.throws(function () { xzDecompress(new Uint8Array(16), 0); }, 'Not an XZ stream');
  });
});

describe('M1 package parser — parseM1Pkg', function () {

  var pkg = parseM1Pkg(m1tPackage(M1T_V1));

  it('reads metadata, comment log and firmware identity', function () {
    assert.equal(pkg.tuneName, 'Tune V1');
    assert.equal(pkg.modified, '2026-10-15T20:51:06.000Z');
    assert.equal(pkg.serial, 30924);
    assert.equal(pkg.firmware.version, '01.00.0002');
    assert.equal(pkg.firmware.id, '00112233445566778899AABBCCDDEEFF');
    assert.deepEqual(pkg.commentLog, [{ time: '2026-10-15T20:51:05.000Z', title: 'Tune V1', note: 'a note' }]);
  });

  it('reads calibration selections', function () {
    assert.deepEqual(pkg.selections[0], {
      slot: 'Fuel.Injector.Primary.Calibration', name: 'Bosch 980', version: '1.0', raw: 'Bosch 980.1.0'
    });
    assert.equal(pkg.selections.length, 2);
  });

  it('extracts scalar parameters with units, tags and enum labels', function () {
    var limit = m1tFind(pkg, 'Engine.Speed Limit');
    assert.equal(limit.value, 42000);
    assert.equal(limit.unit, 'deg/s');
    assert.equal(limit.displayUnit, 'rpm');
    assert.deepEqual(limit.tags, ['Engine', 'Tune']);
    assert.equal(m1tFind(pkg, 'Engine.Polarity').label, 'Normal');
  });

  it('skips channels that live outside the calibration section', function () {
    assert.equal(m1tFind(pkg, 'Engine.Speed'), undefined);
  });

  it('extracts tables with axes, used site counts and decoded names', function () {
    var t = m1tFind(pkg, 'Engine.Map & Trim');
    assert.equal(t.kind, 'Table');
    assert.equal(t.values.length, 6);
    assert.closeTo(t.values[2], 0.7, 1e-6);
    assert.deepEqual(t.axes[0].values, [0, 6000, 6000]);
    assert.equal(t.axes[0].sites, 2);
    assert.equal(t.axes[0].input, 'Engine.Speed');
    assert.equal(t.axes[1].unit, 'Pa');
  });

  it('stops used sites at zero-filled unused axis sites', function () {
    assert.equal(m1pkgUsedSites([0, 3000, 48000, 0, 0]), 3);
    assert.equal(m1pkgUsedSites([10, 16, 0.05, 0.05]), 2);
    assert.equal(m1pkgUsedSites([1, 2, 3]), 3);
    assert.equal(m1pkgUsedSites([5]), 1);
  });

  it('reads IO resources as five pin IDs', function () {
    var r = m1tFind(pkg, 'Engine.Switch Resource');
    assert.equal(r.type, 'io_resource');
    assert.deepEqual(r.methods, ['av_switch']);
    assert.deepEqual(r.value, ['0x0000', '0x0000', '0x0000', '0x0000', '0x0000']);
  });

  it('reads the signed baseline copy when asked', function () {
    var base = parseM1Pkg(m1tPackage(M1T_V1), { copy: 'baseline' });
    assert.equal(base.copy, 'baseline');
    assert.equal(m1tFind(base, 'Engine.Map & Trim').values[0], 1);
  });

  it('rejects files that are not M1 packages', function () {
    assert.throws(function () { parseM1Pkg(new Uint8Array(32)); }, 'Not an M1 package');
  });
});

describe('M1 package parser — m1pkgCells / diffM1Pkg', function () {

  var a = parseM1Pkg(m1tPackage(M1T_V1)), b = parseM1Pkg(m1tPackage(M1T_V2));

  it('flattens tables into axis and body cells keyed by [x,y]', function () {
    var cells = m1pkgCells(m1tFind(a, 'Engine.Map & Trim'));
    assert.equal(cells.length, 3 + 2 + 6);
    assert.deepEqual(cells[0], { key: 'X[0]', value: 0 });
    assert.equal(cells[5].key, 'V[0,0]');
    assert.equal(cells[7].key, 'V[2,0]');
    assert.equal(cells[8].key, 'V[0,1]');
  });

  it('reports no changes between identical packages', function () {
    var d = diffM1Pkg(a, parseM1Pkg(m1tPackage(M1T_V1)));
    assert.equal(d.items.length, 0);
    assert.equal(d.selections.length, 0);
  });

  it('reports changed values, table cells, IO resources and selections', function () {
    var d = diffM1Pkg(a, b), byName = {};
    d.items.forEach(function (i) { byName[i.name] = i; });
    assert.equal(d.from, 'Tune V1');
    assert.equal(d.to, 'Tune V2');
    assert.equal(d.firmwareChanged, false);
    assert.deepEqual(Object.keys(byName).sort(),
      ['Engine.Map & Trim', 'Engine.Polarity', 'Engine.Speed Limit', 'Engine.Switch Resource']);
    assert.deepEqual(byName['Engine.Speed Limit'].cells, [{ key: '', from: 42000, to: 45000, fromLabel: undefined, toLabel: undefined }]);
    assert.equal(byName['Engine.Polarity'].cells[0].toLabel, 'Inverting');
    assert.equal(byName['Engine.Map & Trim'].cells.length, 1);
    assert.equal(byName['Engine.Map & Trim'].cells[0].key, 'V[2,0]');
    assert.deepEqual(d.selections, [{
      slot: 'Fuel.Injector.Primary.Calibration', from: 'Bosch 980.1.0', to: 'Injector Dynamics ID850.1.0'
    }]);
  });
});

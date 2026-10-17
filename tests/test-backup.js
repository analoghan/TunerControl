/**
 * test-backup.js — Tests for lib/backup.js: the full backup format helpers (the stores are exercised end to end).
 */

describe('Backup — format helpers', function () {
  it('round-trips bytes through base64, including large buffers', function () {
    var bytes = new Uint8Array(100000);
    for (var i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 255;
    var back = bkFromBase64(bkToBase64(bytes));
    assert.equal(back.length, bytes.length);
    assert.ok(back.every(function (b, k) { return b === bytes[k]; }));
    assert.equal(bkToBase64(new Uint8Array([104, 105])), 'aGk=');
  });

  it('accepts full and older M1-only backups, and nothing else', function () {
    bkCheck({ format: 'tunercontrol-backup', packages: [] });
    bkCheck({ format: 'tunercontrol-m1-backup', packages: [] });
    assert.throws(function () { bkCheck({ format: 'other', packages: [] }); }, 'Not a TunerControl backup');
    assert.throws(function () { bkCheck(null); }, 'Not a TunerControl backup');
  });

  it('summarises what a backup holds', function () {
    var c = {};
    bkContents({ packages: [{}, {}], packageFiles: [{}], resourceNames: { 'M142|x': 'AT4', 'label|g:Fuel': 'Fuel', 'label|r:at1': 'IAT' },
      runs: [{}], harnesses: [{ revisions: [{}, {}, {}] }, { revisions: [{}] }], harnessSystems: [{ canNetworks: [{}, {}] }],
      harnessImages: [{}], settings: { a: '1' } }).forEach(function (x) { c[x[0]] = x[1]; });
    assert.deepEqual([c['Tunes'], c['Original .m1pkg files'], c['Resource names'], c['Labels'], c['Tuning history runs'], c['Harnesses'],
      c['Harness revisions'], c['Harness systems'], c['CAN networks'], c['Harness pictures'], c['Page settings']], [2, 1, 1, 2, 1, 2, 4, 1, 2, 1, 1]);
  });
});

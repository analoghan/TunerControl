/**
 * test-knock-freq.js — Bore-based knock frequencies (knock/knock-freq.js), MoTeC M1 training method.
 */
describe('Knock frequencies from bore', function () {
  it('reproduces the training example: 87.5 mm → 6,500 Hz first order, 13,000 Hz second', function () {
    var f = knockFrequencies(87.5);
    assert.equal(f.first, 6500);
    assert.equal(f.second, 13000);
  });

  it('gives about 5.5 / 11 kHz for an LT4 (103.25 mm) and a sweep of first, mid, second, above', function () {
    var f = knockFrequencies(103.25);
    assert.equal(f.first, 5510);
    assert.equal(f.second, 11020);
    assert.deepEqual(f.sweep, [5500, 8300, 11000, 12700]);
  });

  it('rejects an unusable bore', function () {
    assert.equal(knockFrequencies(0), null);
    assert.equal(knockFrequencies(NaN), null);
  });
});

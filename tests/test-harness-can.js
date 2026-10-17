/**
 * test-harness-can.js — Tests for harness/harness-can.js: CAN network checks and diagrams.
 */

function hcNet() {
  // ECU and dash on hub A, PDM on hub B (wired to A); ECU terminated, a terminator on hub B.
  var n = canNewNetwork('CAN 1');
  n.bitrate = 1000;
  n.hubs = [{ id: 'A', name: 'Hub A', notes: '' }, { id: 'B', name: 'Hub B', notes: '' }];
  n.hubLinks = [{ a: 'A', b: 'B' }];
  n.devices = [{ id: 'd1', name: 'M142', hub: 'A', termination: true, bitrate: '', notes: '' },
               { id: 'd2', name: 'Dash', hub: 'A', termination: false, bitrate: '1000', notes: '' },
               { id: 'd3', name: 'PDM30', hub: 'B', termination: false, bitrate: '', notes: '' }];
  n.terminators = [{ id: 't1', name: 'End B', hub: 'B' }];
  return n;
}

function hcFind(checks, text) {
  return checks.filter(function (c) { return c.message.indexOf(text) >= 0; });
}

describe('CAN networks — checks', function () {
  it('accepts a bus with two terminations, one speed and every hub connected', function () {
    assert.deepEqual(canNetworkChecks(hcNet()), []);
    assert.equal(canTerminations(hcNet()), 2);
  });

  it('counts terminations: none, one, three', function () {
    var n = hcNet();
    n.devices[0].termination = false; n.terminators = [];
    assert.equal(hcFind(canNetworkChecks(n), 'No termination')[0].severity, 'error');
    n.devices[0].termination = true;
    assert.equal(hcFind(canNetworkChecks(n), 'Only one termination').length, 1);
    n = hcNet(); n.devices[2].termination = true;
    var three = hcFind(canNetworkChecks(n), '3 terminations')[0];
    assert.equal(three.severity, 'warning');
    assert.ok(three.message.indexOf('40 Ω') >= 0, 'bus resistance with three');
  });

  it('a terminator not plugged into a hub does not count', function () {
    var n = hcNet();
    n.terminators[0].hub = '';
    assert.equal(canTerminations(n), 1);
    assert.equal(hcFind(canNetworkChecks(n), 'not plugged into a hub').length, 1);
  });

  it('flags a device at a different speed, and reads speeds written with units', function () {
    var n = hcNet();
    n.devices[1].bitrate = '500 kbit/s';
    var c = hcFind(canNetworkChecks(n), 'Runs at 500 kbit/s')[0];
    assert.equal(c.where, 'Dash');
    assert.ok(c.message.indexOf('1 Mbit/s') >= 0);
    assert.equal(canBitrate('1 Mbit/s'), 1000);
    assert.equal(canBitrate(''), null);
    assert.equal(canDeviceBitrate(n, n.devices[0]), 1000, 'blank = the network speed');
  });

  it('finds hubs that are not wired to the others and devices with no hub', function () {
    var n = hcNet();
    canSetHubLink(n, 'B', 'A', false);
    assert.equal(n.hubLinks.length, 0);
    assert.equal(hcFind(canNetworkChecks(n), 'Not wired to Hub A')[0].where, 'Hub B');
    n.devices[2].hub = '';
    assert.equal(hcFind(canNetworkChecks(n), 'Not connected to a hub')[0].where, 'PDM30');
  });

  it('removing a hub disconnects what was plugged into it', function () {
    var n = hcNet();
    canRemoveHub(n, 'B');
    assert.deepEqual(n.hubLinks, []);
    assert.equal(n.devices[2].hub, '');
    assert.equal(n.terminators[0].hub, '');
  });
});

describe('CAN networks — diagram', function () {
  it('draws hubs, devices and terminators joined by twisted pairs', function () {
    var d = canNetworkDiagram(hcNet());
    assert.ok(d.svg.indexOf('<svg') === 0);
    assert.equal((d.svg.match(/class="can-pair"/g) || []).length, 5, '3 devices + 1 terminator + 1 hub link');
    assert.equal((d.svg.match(/class="can-hub"/g) || []).length, 2);
    assert.ok(d.svg.indexOf('120 Ω on') >= 0 && d.svg.indexOf('Term off') >= 0);
    assert.ok(d.svg.indexOf('120 Ω terminator') >= 0);
    assert.ok(d.svg.indexOf('1 Mbit/s') >= 0);
    assert.ok(d.svg.indexOf('data-can-item="d1"') >= 0, 'clickable devices');
  });

  it('shows items not on a hub separately and links between non-neighbouring hubs as a curve', function () {
    var n = hcNet();
    n.hubs.push({ id: 'C', name: 'Hub C', notes: '' });
    canSetHubLink(n, 'B', 'C', true);
    canSetHubLink(n, 'A', 'C', true);   // A and C are not next to each other in the row
    n.devices.push({ id: 'd4', name: 'Loose', hub: '', termination: false, bitrate: '', notes: '' });
    var d = canNetworkDiagram(n);
    assert.ok(d.svg.indexOf('Not connected to a hub') >= 0);
    assert.equal((d.svg.match(/class="can-pair"/g) || []).length, 7, '3 + 1 terminator + 3 hub links');
  });

  it('twists the two wires around the path', function () {
    var pair = canTwistedPair(canSample([0, 0], [100, 0]), 'x');
    var pts = pair.match(/points="([^"]+)"/g);
    assert.equal(pts.length, 4, 'two wires, each with an edge');
    var ys = pts[3].replace(/points="|"/g, '').split(' ').map(function (p) { return parseFloat(p.split(',')[1]); });
    assert.ok(Math.max.apply(null, ys) > 2 && Math.min.apply(null, ys) < -2, 'CAN-H swings to both sides');
  });
});

describe('CAN networks — power', function () {
  function powered() {
    var n = hcNet();
    n.devices[1].power = true;   // Dash on hub A, powered through its CAN connection
    n.feeds = [{ id: 'f1', name: 'Switched 12V', source: 'PDM30 OUT 5', to: 'hub:B', notes: '' }];
    return n;
  }

  it('power fed into one hub reaches devices on hubs wired to it', function () {
    var n = powered();
    assert.deepEqual(canNetworkChecks(n), []);
    assert.ok(canPowered(n).devices.d2);
  });

  it('warns about a powered device with no feed reaching it, and about loose or sourceless feeds', function () {
    var n = powered();
    canSetHubLink(n, 'A', 'B', false);   // hub A no longer gets B's power
    assert.equal(hcFind(canNetworkChecks(n), 'no power feed reaches its hub')[0].where, 'Dash');
    n = powered();
    n.feeds = [];
    assert.equal(hcFind(canNetworkChecks(n), 'the network has no power feed').length, 1);
    n = powered();
    n.feeds[0].to = ''; n.feeds[0].source = '';
    var c = canNetworkChecks(n);
    assert.equal(hcFind(c, 'not connected to a hub or device').length, 1);
    assert.equal(hcFind(c, 'has no source').length, 1);
  });

  it('a feed into a device powers that device; removing the device or its hub disconnects feeds', function () {
    var n = hcNet();
    n.feeds = [{ id: 'f1', name: 'Dash feed', source: 'Battery', to: 'device:d2' }];
    assert.ok(canPowered(n).devices.d2);
    assert.equal(canFeedTarget(n, n.feeds[0]).device.name, 'Dash');
    canRemoveDevice(n, 'd2');
    assert.equal(n.feeds[0].to, '');
    n = powered();
    canRemoveHub(n, 'B');
    assert.equal(n.feeds[0].to, '');
  });

  it('older networks without feeds still work', function () {
    var n = hcNet();
    delete n.feeds;
    assert.deepEqual(canNetworkChecks(n), []);
    assert.ok(canNetworkDiagram(n).svg.indexOf('<svg') === 0);
  });

  it('draws two power wires beside a powered connection and into the network from each feed', function () {
    var d = canNetworkDiagram(powered());
    assert.equal((d.svg.match(/class="can-power"/g) || []).length, 2, 'Dash link + the feed into hub B');
    assert.equal((d.svg.match(/class="can-pair"/g) || []).length, 5, 'CAN pairs unchanged; a feed has no CAN wires');
    assert.ok(d.svg.indexOf('Power from PDM30 OUT 5') >= 0);
    assert.ok(d.svg.indexOf('>PWR<') >= 0, 'badge on the powered device');
    var n = hcNet();
    n.feeds = [{ id: 'f1', name: 'Dash feed', source: 'Battery', to: 'device:d2' }];
    d = canNetworkDiagram(n);
    assert.ok(d.svg.indexOf('Dash feed') >= 0, 'the feed is drawn next to Dash');
    assert.equal((d.svg.match(/class="can-power"/g) || []).length, 1);
    var pair = canPowerPair(canSample([0, 0], [100, 0]), 'x');
    assert.equal((pair.match(/<polyline/g) || []).length, 4, '+12 V and ground, each with an edge');
  });
});

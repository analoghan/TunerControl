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

function hcPin(cavity, fn) {
  return { cavity: cavity, terminal: '', wirePn: '', wire: 'TXL 22 YEL', function: fn, note: '', remote: '' };
}

function hcMembers() {
  // An engine harness with the M142's three buses and a chassis harness with the dash connector.
  return [{ id: 'eng', name: 'Engine', model: { connectors: [{ id: 'M142.C', title: '', pins: [
      hcPin('14', 'M142 CAN1 High'), hcPin('15', 'M142 CAN1 Low'), hcPin('16', 'M142 CAN2 High'), hcPin('17', 'M142 CAN2 Low'),
      hcPin('18', 'CAN Bus 3 High'), hcPin('19', 'CAN Bus 3 Low')] }], splices: [] } },
    { id: 'chas', name: 'Chassis', model: { connectors: [{ id: 'DASH', title: '', pins: [
      hcPin('1', 'CAN 1 High'), hcPin('2', 'CAN 1 Low'), hcPin('3', 'CAN 1 Power'), hcPin('4', 'CAN 1 Ground'), hcPin('5', 'Canister Vent Ground')] }],
      splices: [] } }];
}

function hcLinked() {
  var n = hcNet();
  n.devices[0].pins = { h: { harness: 'eng', connector: 'M142.C', cavity: '14' }, l: { harness: 'eng', connector: 'M142.C', cavity: '15' } };
  n.devices[1].power = true;
  n.devices[1].pins = { h: { harness: 'chas', connector: 'DASH', cavity: '1' }, l: { harness: 'chas', connector: 'DASH', cavity: '2' },
    plus: { harness: 'chas', connector: 'DASH', cavity: '3' }, gnd: { harness: 'chas', connector: 'DASH', cavity: '4' } };
  n.feeds = [{ id: 'f1', name: 'Switched 12V', source: 'PDM30 OUT 5', to: 'hub:B', notes: '' }];
  return n;
}

describe('CAN networks — harness pins', function () {
  it('reads CAN wires from pin functions', function () {
    assert.deepEqual(canFunctionRole('CAN 1 High'), { role: 'h', buses: ['1'] });
    assert.deepEqual(canFunctionRole('M142 CAN2 Low'), { role: 'l', buses: ['2'] });
    assert.deepEqual(canFunctionRole('CAN Bus 3 High'), { role: 'h', buses: ['3'] });
    assert.deepEqual(canFunctionRole('CAN 1/2 Power'), { role: 'plus', buses: ['1', '2'] });
    assert.deepEqual(canFunctionRole('CAN Power Ground'), { role: 'gnd', buses: [] });
    assert.equal(canFunctionRole('CANH').role, 'h');
    assert.equal(canFunctionRole('Canister Vent Ground'), null, 'not CAN');
    assert.equal(canFunctionRole('E888 CAN Connection'), null, 'no wire named');
    assert.equal(canNetBus({ name: 'CAN 2' }), '2');
    assert.equal(canNetBus({ name: 'Main bus' }), '');
  });

  it('suggests pins from a connector, using the bus number when it has several', function () {
    var m = hcMembers(), n = hcNet(), d = n.devices[0];
    assert.deepEqual(canSuggestPins(n, d, false, m, 'eng', 'M142.C'), { h: '14', l: '15' }, 'network CAN 1');
    n.name = 'Main bus';
    assert.deepEqual(canSuggestPins(n, d, false, m, 'eng', 'M142.C'), {}, 'three buses and no number: unsure');
    d.pins = { h: { harness: 'eng', connector: 'M142.C', cavity: '18' } };
    assert.deepEqual(canSuggestPins(n, d, false, m, 'eng', 'M142.C'), { h: '18', l: '19' }, 'the bus of the pin already linked');
    var dash = n.devices[1];
    dash.power = true;
    assert.deepEqual(canSuggestPins(n, dash, false, m, 'chas', 'DASH'), { h: '1', l: '2', plus: '3', gnd: '4' });
    assert.deepEqual(canSuggestPins(n, { id: 'f' }, true, m, 'chas', 'DASH'), { plus: '3', gnd: '4' }, 'a feed has power wires only');
  });

  it('accepts pins that exist and match their functions', function () {
    assert.deepEqual(canNetworkChecks(hcLinked(), hcMembers()), []);
    assert.deepEqual(canNetworkChecks(hcLinked()), [], 'no pin checks without the harnesses');
  });

  it('flags pins that are gone, swapped, used twice or on another bus', function () {
    var m = hcMembers(), n = hcLinked(), ecu = n.devices[0], dash = n.devices[1];
    ecu.pins.h.cavity = '99';
    assert.equal(hcFind(canNetworkChecks(n, m), 'has no cavity 99').length, 1);
    ecu.pins.h = { harness: 'gone', connector: 'X', cavity: '1' };
    assert.equal(hcFind(canNetworkChecks(n, m), 'not in this system').length, 1);
    ecu.pins.h = { harness: 'eng', connector: 'M142.X', cavity: '1' };
    assert.equal(hcFind(canNetworkChecks(n, m), 'has no connector M142.X').length, 1);
    ecu.pins.h = { harness: 'eng', connector: 'M142.C', cavity: '' };
    assert.equal(hcFind(canNetworkChecks(n, m), 'pick the pin').length, 1);
    ecu.pins.h = { harness: 'eng', connector: 'M142.C', cavity: '15' };
    var c = canNetworkChecks(n, m);
    assert.equal(hcFind(c, 'whose function is "M142 CAN1 Low"').length, 1, 'CAN-H on a CAN-L pin');
    assert.equal(hcFind(c, 'is used for both M142 CAN-H and M142 CAN-L')[0].severity, 'error');
    ecu.pins = { h: { harness: 'eng', connector: 'M142.C', cavity: '16' }, l: { harness: 'eng', connector: 'M142.C', cavity: '15' } };
    c = canNetworkChecks(n, m);
    assert.equal(hcFind(c, 'but this network is CAN 1').length, 1);
    assert.equal(hcFind(c, 'different CAN buses (CAN 1, CAN 2)').length, 1);
    dash.power = false;
    dash.pins.plus.cavity = '99';
    assert.equal(hcFind(canNetworkChecks(n, m), 'cavity 99').length, 0, 'power pins of an unpowered device are not checked');
  });

  it('follows a renamed connector and lists the pins each harness has linked', function () {
    var n = hcLinked(), nets = [n];
    assert.ok(canRenameConnector(nets, 'eng', 'M142.C', 'ECU.C'));
    assert.equal(n.devices[0].pins.h.connector, 'ECU.C');
    assert.equal(canRenameConnector(nets, 'chas', 'M142.C', 'X'), false, 'only links into that harness');
    var uses = canPinUses(nets, 'chas');
    assert.deepEqual(Object.keys(uses).sort(), ['DASH|1', 'DASH|2', 'DASH|3', 'DASH|4']);
    assert.equal(uses['DASH|3'][0].role, 'plus');
    assert.equal(uses['DASH|3'][0].item.name, 'Dash');
  });

  it('labels the wires with their pins in the diagram', function () {
    var svg = canNetworkDiagram(hcLinked()).svg;
    assert.ok(svg.indexOf('>H M142.C.14<') >= 0 && svg.indexOf('>L M142.C.15<') >= 0, 'CAN pins');
    assert.ok(svg.indexOf('>+ DASH.3<') >= 0 && svg.indexOf('>− DASH.4<') >= 0, 'power pins');
    assert.ok(svg.indexOf('M142 ⇄ Hub A — CAN-H M142.C.14, CAN-L M142.C.15') >= 0, 'tooltip');
    assert.equal(canPinText({ connector: 'M142.C', cavity: '14' }), 'M142.C.14');
  });
});

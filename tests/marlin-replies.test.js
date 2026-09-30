import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEED_LOG_FILTER, parseLogLine, normalizeSent, classifySent, parsePosition, parseLimits, parseMarker, parseUnknownCommand,
  limitsWarnings, limitsWarningText,
} from '../src/core/marlin-replies.js';

test('parseLogLine: direction and text', () => {
  assert.deepEqual(parseLogLine('Send: N12 G0 X10*85'), { dir: 'send', text: 'N12 G0 X10*85' });
  assert.deepEqual(parseLogLine('Recv: ok X:0.0 Y:0.0'), { dir: 'recv', text: 'ok X:0.0 Y:0.0' });
  assert.equal(parseLogLine('Changing monitoring state from "Offline"'), null);
});

test('normalizeSent: without line number, checksum, comment; case and spaces', () => {
  assert.equal(normalizeSent('N12 G0 X10*85'), 'G0 X10');
  assert.equal(normalizeSent('N40 G0 X10 Y10*97'), 'G0 X10 Y10');
  assert.equal(normalizeSent('g1  x5   ; вверх'), 'G1 X5');
  assert.equal(normalizeSent('M118 PLT_B 7'), 'M118 PLT_B 7');
});

test('classifySent: command kinds', () => {
  const k = (c) => classifySent(c);
  assert.equal(k('G28'), 'home');
  assert.equal(k('G28 X Y'), 'home');
  assert.equal(k('N5 G92 X0 Y0*12'), 'setpos');
  for (const c of ['G0 X1', 'G1 Y2', 'G01 X1', 'G2 X1 I1', 'G3 X1', 'G91']) assert.equal(k(c), 'move', c);
  assert.equal(k('G90'), 'mode');
  for (const c of ['M114', 'M211', 'M118 PLT_B 1']) assert.equal(k(c), 'query', c);
  for (const c of ['G10', 'G29', 'M400', 'M84', 'M104 S0', '', 'X10']) assert.equal(k(c), 'other', c);
});

test('parsePosition: variants of the M114 reply', () => {
  assert.deepEqual(parsePosition('X:10.00 Y:20.00 Z:5.00 E:0.00 Count X:800 Y:1600 Z:2000'), { x: 10, y: 20, z: 5 });
  assert.deepEqual(parsePosition('ok X:0.0 Y:0.0 Z:0.0 E:0.0 Count: A:0 B:0 C:0'), { x: 0, y: 0, z: 0 });
  assert.deepEqual(parsePosition('X:-5.25 Y:50 Z:8.5 E:0'), { x: -5.25, y: 50, z: 8.5 });
  assert.equal(parsePosition('ok'), null);
  assert.equal(parsePosition('T:21.30/ 0.00 B:21.30/ 0.00'), null);
});

test('parseLimits: Soft endstops with different amounts of spaces', () => {
  const want = { enabled: true, min: { x: 0, y: 0, z: 0 }, max: { x: 235, y: 235, z: 280 } };
  assert.deepEqual(parseLimits('echo:Soft endstops: On   Min:  X0.00 Y0.00 Z0.00   Max:  X235.00 Y235.00 Z280.00'), want);
  assert.deepEqual(parseLimits('echo:Soft endstops: ON Min: X0 Y0 Z0 Max: X235 Y235 Z280'), want);
  assert.deepEqual(parseLimits('Soft endstops: Off   Min:  X-5.5 Y0 Z0   Max:  X235 Y235 Z280'),
    { enabled: false, min: { x: -5.5, y: 0, z: 0 }, max: { x: 235, y: 235, z: 280 } });
  assert.equal(parseLimits('echo:Soft endstops: On'), null);
  // Neptune 3 Pro (Marlin 2.1): two lines joined by the feed
  assert.deepEqual(parseLimits('\n  M211 S1 ; ON\n  Min:  X-5.00 Y0.00 Z0.00   Max:  X235.00 Y232.00 Z283.00'),
    { enabled: true, min: { x: -5, y: 0, z: 0 }, max: { x: 235, y: 232, z: 283 } });
  assert.equal(parseLimits('  M211 S0 ; OFF\n  Min:  X0 Y0 Z0   Max:  X1 Y1 Z1').enabled, false);
  assert.equal(parseLimits('  M211 S1 ; ON'), null);
  assert.equal(parseLimits('  Min:  X-5.00 Y0.00 Z0.00   Max:  X235.00 Y232.00 Z283.00'), null);
  assert.equal(parseLimits('ok'), null);
});

test('parseMarker and parseUnknownCommand', () => {
  assert.deepEqual(parseMarker('PLT_B 1a2'), { kind: 'B', rid: '1a2' });
  assert.deepEqual(parseMarker('echo:PLT_E 7 '), { kind: 'E', rid: '7' });
  assert.equal(parseMarker('echo:Unknown command: "M118 PLT_B 7"'), null);
  assert.equal(parseUnknownCommand('echo:Unknown command: "M118 PLT_B 7"'), 'M118 PLT_B 7');
  assert.equal(parseUnknownCommand('ok'), null);
});

// The server filter applies Python re.search; here we check the same expression as a JS RegExp.
test('log filter: passes the needed, cuts the rest', () => {
  const re = new RegExp(FEED_LOG_FILTER);
  const pass = [
    'Send: N12 G0 X10*85', 'Send: G1 X5 Y5', 'Send: G28', 'Send: N3 G92 X0*10', 'Send: G91', 'Send: M211', 'Send: N9 M114*33',
    'Send: M118 PLT_B 1', 'Send: G01 X1', 'Send: G2 X1 I1', 'Send: G90',
    'Recv: X:10.00 Y:20.00 Z:5.00 E:0.00 Count X:800', 'Recv: ok X:0.0 Y:0.0 Z:0.0 E:0.0',
    'Recv: echo:Soft endstops: On   Min:  X0.00 Y0.00 Z0.00   Max:  X235.00 Y235.00 Z280.00',
    'Recv:   M211 S1 ; ON', 'Recv:   Min:  X-5.00 Y0.00 Z0.00   Max:  X235.00 Y232.00 Z283.00',
    'Recv: PLT_B 1', 'Recv: echo:PLT_E 1', 'Recv: echo:Unknown command: "M118 PLT_B 1"',
  ];
  const cut = [
    'Send: G10', 'Send: G29', 'Send: M104 S200', 'Send: M400', 'Send: N1 M105*1', 'Send: G0X1',
    'Recv: ok', 'Recv: wait', 'Recv: T:21.30/ 0.00 B:21.30/ 0.00 @:64', 'Recv: Not SD printing', 'Changing monitoring state',
  ];
  for (const l of pass) assert.ok(re.test(l), l);
  for (const l of cut) assert.ok(!re.test(l), l);
});

test('limitsWarnings: the profile is wider than the firmware — specific axes', () => {
  const fw = { enabled: true, min: { x: 0, y: 0, z: 0 }, max: { x: 235, y: 235, z: 280 } };
  assert.deepEqual(limitsWarnings({ limX0: 0, limX1: 240, limY0: 0, limY1: 230 }, fw), [{ axis: 'X', side: 'max', profile: 240, firmware: 235 }]);
  assert.deepEqual(limitsWarnings({ limX0: -5, limX1: 230, limY0: 0, limY1: 230 }, fw), [{ axis: 'X', side: 'min', profile: -5, firmware: 0 }]);
  assert.deepEqual(limitsWarnings({ limX0: 0, limX1: 235, limY0: 0, limY1: 235 }, fw), []);
  assert.deepEqual(limitsWarnings({ limX0: -50, limX1: 500, limY0: 0, limY1: 230 }, { ...fw, enabled: false }), []);
  assert.deepEqual(limitsWarnings({ limX0: -50, limX1: 500 }, null), []);
  assert.match(limitsWarningText(limitsWarnings({ limX0: 0, limX1: 240, limY0: 0, limY1: 230 }, fw)), /X макс: в профиле 240, в прошивке 235/);
  assert.equal(limitsWarningText([]), '');
});

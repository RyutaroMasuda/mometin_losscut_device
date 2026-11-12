const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { CommandLines } = require('../esp32-serial.js');

test('serial commands survive fragmented CRLF and ignore boot logs or oversized lines', () => {
  let count = 0;
  const lines = new CommandLines(() => count++);
  lines.push('READY\r\nSTOP_');
  assert.equal(count, 0);
  lines.push('LOSS\r');
  assert.equal(count, 0);
  lines.push('\nSTOP_LOSS\nnoiseSTOP_LOSS\n');
  assert.equal(count, 2);
  lines.push('x'.repeat(129) + 'STOP_LOSS\nSTOP_LOSS\n');
  assert.equal(count, 3);
});

function game(search = '') {
  const elements = new Map();
  const context2d = new Proxy({}, { get: () => () => {} });
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', style: {}, dataset: {}, classList: { toggle() {} },
      close() {}, showModal() {}, addEventListener() {},
      querySelector() { return element(id + '-child'); },
      getBoundingClientRect() { return { width: 800, height: 500 }; },
      getContext() { return context2d; }
    });
    return elements.get(id);
  }
  let receive;
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    history: { replaceState() {} }, location: { hash: '', search },
    requestAnimationFrame() {}, devicePixelRatio: 1, URLSearchParams,
    StopLossSerial: { mount(callback) { receive = callback; } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../game.js'), 'utf8'), context);
  return { context, run: code => vm.runInContext(code, context), receive, element };
}

test('GPIO command closes all long units at current price and does not repeat', () => {
  const g = game();
  g.run("sound=false; state.phase='live'; order(1); order(1); state.price=state.entry-5");
  assert.equal(g.receive(), true);
  assert.equal(g.run('state.units'), 0);
  assert.equal(g.run('state.cash'), 990000);
  assert.equal(g.run('state.count'), 1);
  assert.match(g.run('state.logs[0]'), /ESP32強制損切り/);
  assert.equal(g.receive(), false);
  assert.equal(g.run('state.count'), 1);
});

test('paused short is closed even when profitable', () => {
  const g = game();
  g.run("sound=false; state.phase='live'; order(-1); state.price=state.entry-3; state.phase='paused'");
  assert.equal(g.receive(), true);
  assert.equal(g.run('state.cash'), 1003000);
  assert.equal(g.run('state.side'), 0);
  assert.equal(g.run('state.phase'), 'paused');
});

test('idle signal is ignored, not carried into next order or next game', () => {
  const g = game();
  assert.equal(g.receive(), false);
  g.run("sound=false; state.phase='live'; order(1)");
  assert.equal(g.run('state.units'), 1000);
  g.run("fresh('next'); state.phase='live'; order(-1)");
  assert.equal(g.run('state.units'), 1000);
  assert.equal(g.run('state.count'), 0);
});


test('volatility scales the same seeded initial market and accepts shared settings', () => {
  const normal = game('?vol=1');
  const large = game('?vol=4');
  normal.run("fresh('same-seed')");
  large.run("fresh('same-seed')");
  const baseMove = normal.run('state.price - 10000');
  assert.ok(Math.abs(large.run('state.price - 10000') - baseMove * 4) < 1e-7);
  assert.equal(game('?vol=999').run('volatility'), 1);
});

test('live volatility change preserves positions and scales future movement only', () => {
  const g = game();
  g.run("sound=false;state.phase='live';order(1)");
  const price = g.run('state.price');
  const entry = g.run('state.entry');
  g.run('setVolatility(4)');
  assert.equal(g.run('state.price'), price);
  assert.equal(g.run('state.entry'), entry);
  assert.equal(g.run('state.units'), 1000);
  assert.equal(g.run('state.time'), 60);
  g.run('state.rand=()=>0.75;last=1000;acc=0;frame(1100)');
  assert.ok(Math.abs(g.run('state.price') - price - 4) < 1e-8);
  assert.equal(g.run('state.units'), 1000);
  assert.equal(g.receive(), true);
});

test('ready volatility change regenerates same seed and rejects invalid values', () => {
  const g = game();
  g.run("fresh('same-seed')");
  const move = g.run('state.price-10000');
  g.run('setVolatility(0.25)');
  assert.ok(Math.abs(g.run('state.price-10000') - move * 0.25) < 1e-7);
  assert.equal(g.run('state.seed'), 'same-seed');
  g.run('setVolatility(0);setVolatility(NaN);setVolatility(100)');
  assert.equal(g.run('volatility'), 0.25);
});


test('loss alarm fires only after threshold crossing, re-arms on recovery, and leaves position open', () => {
  const g = game();
  g.run("sound=false;state.phase='live';state.price=1000;order(1);sound=true;globalThis.alarmCount=0;playLossAlarm=()=>{alarmCount++}");
  g.run('state.price=800;hud()');
  assert.equal(g.run('alarmCount'), 0);
  g.run('state.price=799.99;hud();hud();hud()');
  assert.equal(g.run('alarmCount'), 1);
  assert.equal(g.run('state.units'), 1000);
  assert.match(g.element('lossWarning').textContent, /警告/);
  g.run('state.price=850;hud();state.price=790;hud()');
  assert.equal(g.run('alarmCount'), 2);
  g.receive();
  assert.equal(g.run('state.lossWarningActive'), false);
  assert.equal(g.element('lossWarning').textContent, '保有ポジションなし');
});

test('short loss alarm responds immediately to editable threshold while paused', () => {
  const g = game();
  g.run("sound=false;state.phase='live';state.price=1000;order(-1);state.phase='paused';state.price=1100;sound=true;globalThis.alarmCount=0;playLossAlarm=()=>{alarmCount++};hud()");
  assert.equal(g.run('alarmCount'), 0);
  g.run('setLossThreshold(5)');
  assert.equal(g.run('alarmCount'), 1);
  assert.equal(g.run('state.units'), 1000);
  assert.equal(g.run('state.phase'), 'paused');
  g.run('setLossThreshold(5);hud()');
  assert.equal(g.run('alarmCount'), 1);
  g.run('setLossThreshold(15)');
  assert.equal(g.run('state.lossWarningActive'), false);
});

test('muted alarm still shows warning, invalid thresholds are rejected, new game clears warning', () => {
  const g = game();
  g.run("sound=false;state.phase='live';state.price=1000;order(1);globalThis.alarmCount=0;playLossAlarm=()=>{alarmCount++};state.price=700;hud()");
  assert.equal(g.run('alarmCount'), 0);
  assert.match(g.element('lossWarning').textContent, /消音中/);
  g.run('setLossThreshold(0);setLossThreshold(-20);setLossThreshold(NaN);setLossThreshold(101)');
  assert.equal(g.run('lossThreshold'), 20);
  g.run('setLossThreshold(12.34)');
  assert.equal(g.run('lossThreshold'), 12.3);
  g.run("fresh('reset')");
  assert.equal(g.run('state.lossWarningActive'), false);
  assert.equal(g.element('positionReturn').textContent, 'ポジション損益率：—');
});


test('position return uses initial capital, scales with size, and excludes realized profit', () => {
  const g = game();
  g.run("sound=false;state.phase='live';state.price=10000;order(1);state.price=9980;hud()");
  assert.equal(g.element('positionReturn').textContent, 'ポジション損益率：-2.00%');
  g.run('state.price=10000;order(1);state.price=9980;hud()');
  assert.equal(g.element('positionReturn').textContent, 'ポジション損益率：-4.00%');
  g.run('state.cash=1500000;hud()');
  assert.equal(g.element('positionReturn').textContent, 'ポジション損益率：-4.00%');
  g.run('close();state.price=10000;order(-1);state.price=10020;hud()');
  assert.equal(g.element('positionReturn').textContent, 'ポジション損益率：-2.00%');
});


test('harsh alarm schedules two dissonant voices and four bursts, and stops on mute', () => {
  const g = game();
  g.run(`
    globalThis.recorded = { voices: [], gains: [] };
    const parameter = () => ({
      setValueAtTime(value, time) { recorded.gains.push(value); },
      linearRampToValueAtTime() {}, cancelScheduledValues() {}
    });
    globalThis.window = { AudioContext: class {
      constructor() { this.currentTime = 10; this.destination = {}; }
      resume() {}
      createGain() { return { gain: parameter(), connect() {}, disconnect() {} }; }
      createOscillator() {
        const voice = { frequency: parameter(), connect() {}, disconnect() {},
          start(time) { this.started = time; },
          stop(time) { this.stops ||= []; this.stops.push(time); }
        };
        recorded.voices.push(voice);
        return voice;
      }
    }};
    playLossAlarm();
  `);
  assert.equal(g.run('recorded.voices.length'), 2);
  assert.equal(g.run('recorded.voices[0].type'), 'square');
  assert.equal(g.run('recorded.voices[1].type'), 'sawtooth');
  assert.equal(g.run('recorded.voices.every(v => v.started === 10 && v.stops[0] === 11.5)'), true);
  assert.equal(g.run('recorded.gains.filter(v=>v===0.025).length'), 4);
  g.element('sound').onclick();
  assert.equal(g.run('lossAlarm'), null);
  assert.equal(g.run('recorded.voices.every(v=>v.stops.length===2)'), true);
  g.run('playLossAlarm()');
  assert.equal(g.run('recorded.voices.length'), 2);
});

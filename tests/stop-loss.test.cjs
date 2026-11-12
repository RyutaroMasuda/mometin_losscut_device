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

function game() {
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
    history: { replaceState() {} }, location: { hash: '' },
    requestAnimationFrame() {}, devicePixelRatio: 1,
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

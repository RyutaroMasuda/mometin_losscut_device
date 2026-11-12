/* USB serial bridge. Only a complete STOP_LOSS line can close a position. */
(function (global) {
  'use strict';
  class CommandLines {
    constructor(onStopLoss) { this.pending = ''; this.overflow = false; this.onStopLoss = onStopLoss; }
    push(text) {
      for (const char of text) {
        if (char === '\n') {
          if (!this.overflow && this.pending.replace(/\r$/, '') === 'STOP_LOSS') this.onStopLoss();
          this.pending = ''; this.overflow = false;
        } else if (!this.overflow) {
          this.pending += char;
          if (this.pending.length > 128) { this.pending = ''; this.overflow = true; }
        }
      }
    }
  }

  function mount(onStopLoss) {
    const connect = document.getElementById('espConnect');
    const disconnect = document.getElementById('espDisconnect');
    const status = document.getElementById('espStatus');
    let session = null, connecting = false;
    const show = text => { status.textContent = text; };
    const buttons = () => { connect.disabled = connecting || !!session; disconnect.disabled = !session; };
    if (!global.isSecureContext || !navigator.serial) {
      connect.disabled = true;
      show('USB接続にはPC版Chrome / Edgeで開いてください。HTTPSまたはlocalhostでの起動を推奨します。');
      return;
    }
    async function read(current) {
      const decoder = new TextDecoder();
      const lines = new CommandLines(() => {
        if (session !== current || current.stopping) return;
        const closed = onStopLoss();
        show(closed ? 'GPIO13 L → H：全ポジションを強制決済しました' : 'GPIO13 L → H：受信しました（保有ポジションなし）');
      });
      let failed = false;
      try {
        current.reader = current.port.readable.getReader();
        while (!current.stopping) {
          const { value, done } = await current.reader.read();
          if (done) break;
          lines.push(decoder.decode(value, { stream: true }));
        }
      } catch (error) {
        failed = !current.stopping;
        if (failed) show('接続が切れました。USBとポートを確認し、再接続してください。');
      } finally {
        current.reader?.releaseLock();
        try { await current.port.close(); } catch (_) {}
        if (session === current) {
          session = null;
          if (!failed) show(current.stopping ? 'ESP32：未接続' : 'ESP32との接続が終了しました。再接続してください。');
          buttons();
        }
      }
    }
    connect.addEventListener('click', async () => {
      if (connecting || session) return;
      connecting = true; buttons();
      try {
        // requestPort must run directly from a user click.
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });
        session = { port, reader: null, stopping: false };
        show('ESP32接続中：GPIO13のL → Hを待っています');
        void read(session);
      } catch (error) {
        show(error.name === 'NotFoundError' ? '接続をキャンセルしました' : '接続できません。Arduinoのシリアルモニターを閉じて再接続してください。');
      } finally { connecting = false; buttons(); }
    });
    disconnect.addEventListener('click', async () => {
      if (!session) return;
      session.stopping = true;
      disconnect.disabled = true;
      show('切断しています…');
      try { await session.reader?.cancel(); } catch (_) {}
    });
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { CommandLines };
  else global.StopLossSerial = { mount };
})(globalThis);

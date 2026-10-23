/* Live-audio helpers for the AI partner and live translation.
 *
 *   FTLive.capture(stream, onChunk)  any MediaStream → 16 kHz PCM chunks
 *   FTLive.player()                  queue of 24 kHz PCM chunks → speakers
 *
 * Kept out of app.js because none of it knows about calls, rooms or the UI —
 * it only moves samples.
 */
(function () {
  'use strict';

  const Ctx = window.AudioContext || window.webkitAudioContext;

  async function capture(stream, onChunk) {
    const ctx = new Ctx();
    await ctx.audioWorklet.addModule('/js/pcm-capture-worklet.js');
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-capture');
    node.port.onmessage = (event) => onChunk(event.data);

    // A worklet only runs while something downstream pulls on it. A muted
    // gain to the speakers keeps it running without playing anything.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);

    return {
      setMuted(muted) { node.port.postMessage({ muted }); },
      setGate(level) { node.port.postMessage({ gate: level }); },
      close() {
        try { source.disconnect(); node.disconnect(); } catch (e) { /* already gone */ }
        ctx.close().catch(() => {});
      }
    };
  }

  function player({ onSpeaking } = {}) {
    const ctx = new Ctx();
    const out = ctx.createGain();
    out.connect(ctx.destination);

    const sources = new Set();
    let playhead = 0;
    let speaking = false;
    let idleTimer = null;

    function setSpeaking(next) {
      if (speaking === next) return;
      speaking = next;
      onSpeaking?.(next);
    }

    return {
      play(arrayBuffer) {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const pcm = new Int16Array(arrayBuffer);
        if (!pcm.length) return;
        const buffer = ctx.createBuffer(1, pcm.length, 24000);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 0x8000;

        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(out);
        // A small lead keeps chunks back to back instead of stuttering when
        // the network delivers them slightly late.
        const startAt = Math.max(ctx.currentTime + 0.06, playhead);
        src.start(startAt);
        playhead = startAt + buffer.duration;
        sources.add(src);
        src.onended = () => sources.delete(src);

        setSpeaking(true);
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => setSpeaking(false),
          Math.max(0, (playhead - ctx.currentTime) * 1000) + 150);
      },
      /** Drops everything queued — used when the user talks over the AI. */
      flush() {
        for (const src of sources) { try { src.stop(); } catch (e) { /* ended */ } }
        sources.clear();
        playhead = 0;
        clearTimeout(idleTimer);
        setSpeaking(false);
      },
      setVolume(v) { out.gain.value = v; },
      resume() { return ctx.resume().catch(() => {}); },
      close() {
        this.flush();
        ctx.close().catch(() => {});
      }
    };
  }

  window.FTLive = {
    supported: Boolean(Ctx && window.AudioWorkletNode),
    capture,
    player
  };
})();

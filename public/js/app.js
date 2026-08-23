/* Friends Talk client.
 *
 * Responsibilities, in order of importance:
 *   1. hold the WebRTC peer connection for the call
 *   2. talk to the signaling server over socket.io
 *   3. keep the UI honest about which state the call is actually in
 *
 * Everything persisted lives in localStorage on this device — there is no
 * account, so the client identity is a random id we generate once.
 */

(() => {
  'use strict';

  // ------------------------------------------------------------------ state

  // Empty serverUrl means same origin, which is what the web build wants.
  // Native builds set it, because capacitor://localhost is not a server.
  const socket = io(window.FRIENDSTALK?.serverUrl || undefined, {
    transports: ['websocket', 'polling']
  });

  const state = {
    phase: 'idle',          // idle | searching | matched | live
    mode: 'voice',
    roomId: null,
    initiator: false,
    partner: null,
    iceServers: [],
    muted: false,
    autoCall: false,
    startedAt: 0,
    interests: [],
    myGender: 'unknown',
    voiceFeatures: false,
    captions: false,
    language: 'en',
    translateTo: null
  };

  let pc = null;
  let localStream = null;
  let audioCtx = null;
  let analyser = null;
  let vizRaf = null;
  let timerId = null;
  let pendingCandidates = [];

  const PREFIX = 'ft:';
  const LEGACY_PREFIX = 'wl:';

  /**
   * Carries settings over from the old key prefix, once.
   *
   * The client id matters most: friendships and blocks are stored server-side
   * against it, so generating a fresh one would silently disconnect an existing
   * user from their own friends list. Everything else is convenience.
   */
  function migrateLegacyKeys() {
    if (localStorage.getItem(PREFIX + 'migrated')) return;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(LEGACY_PREFIX)) continue;
      const moved = PREFIX + key.slice(LEGACY_PREFIX.length);
      if (localStorage.getItem(moved) === null) {
        localStorage.setItem(moved, localStorage.getItem(key));
      }
    }
    localStorage.setItem(PREFIX + 'migrated', '1');
  }
  migrateLegacyKeys();

  const store = {
    get clientId() {
      let id = localStorage.getItem(PREFIX + 'clientId');
      if (!id) {
        id = 'c-' + (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now());
        localStorage.setItem(PREFIX + 'clientId', id);
      }
      return id;
    },
    read(key, fallback) {
      try { return JSON.parse(localStorage.getItem(PREFIX + key)) ?? fallback; }
      catch { return fallback; }
    },
    write(key, value) {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    }
  };

  // ----------------------------------------------------------------- helpers

  const $ = (id) => document.getElementById(id);

  const el = {
    callBtn: $('call-btn'), callCap: $('call-cap'), status: $('status'), timer: $('timer'),
    viz: $('viz'), partnerCard: $('partner-card'), partnerName: $('partner-name'),
    partnerSub: $('partner-sub'), partnerInitial: $('partner-initial'),
    mute: $('btn-mute'), next: $('btn-next'), voice: $('btn-voice'), game: $('btn-game'),
    friend: $('btn-friend'), report: $('btn-report'), block: $('btn-block'),
    chatLog: $('chat-log'), chatInput: $('chat-input'), send: $('btn-send'),
    image: $('btn-image'), file: $('file-input'), typing: $('typing'),
    myCountry: $('my-country'), targets: $('target-countries'),
    controls: $('controls'), moreBtn: $('btn-more'), moreMenu: $('more-menu'),
    interestInput: $('interest-input'), interestTags: $('interest-tags'),
    autoCall: $('auto-call'), premium: $('premium'), genderPref: $('gender-pref'),
    genderWrap: $('gender-pref-wrap'), history: $('history-list'), friends: $('friends-list'),
    online: $('online-count'), calls: $('call-count'), remote: $('remote-audio'),
    ageGate: $('age-gate'), ageConfirm: $('age-confirm'),
    reportModal: $('report-modal'), reportReason: $('report-reason'),
    reportSend: $('report-send'), reportCancel: $('report-cancel'),
    board: $('board'), gameWrap: $('game-wrap'), gameStatus: $('game-status'),
    toasts: $('toasts'),
    queueNote: $('queue-note'), notify: $('notify-on'),
    captionSettings: $('caption-settings'), captionsOn: $('captions-on'),
    captionLangs: $('caption-langs'), myLanguage: $('my-language'),
    translateTo: $('translate-to'), captionBar: $('caption-bar'),
    captionThem: $('caption-them'), captionMe: $('caption-me')
  };

  // The mode picker is a segmented control rather than a <select>, because a
  // binary choice should not be a dropdown. This shim lets the rest of the file
  // keep reading and writing `el.mode.value` as though nothing changed.
  const modeSeg = $('mode-seg');

  function setMode(next) {
    for (const seg of modeSeg.querySelectorAll('.seg')) {
      const on = seg.dataset.mode === next;
      seg.classList.toggle('is-active', on);
      seg.setAttribute('aria-checked', String(on));
    }
    state.mode = next;
    store.write('mode', next);
  }

  el.mode = {
    get value() { return modeSeg.querySelector('.seg.is-active')?.dataset.mode || 'voice'; },
    set value(next) { setMode(next); }
  };

  modeSeg.addEventListener('click', (event) => {
    const seg = event.target.closest('.seg');
    if (seg) setMode(seg.dataset.mode);
  });

  function toast(text, kind = '') {
    const node = document.createElement('div');
    node.className = 'toast ' + kind;
    node.textContent = text;
    el.toasts.appendChild(node);
    setTimeout(() => node.remove(), 3600);
  }

  function setStatus(html) { el.status.innerHTML = html; }

  function systemMessage(text) {
    addMessage({ from: 'system', text });
  }

  // ------------------------------------------------------------- age gating

  function bootAgeGate() {
    if (store.read('ageConfirmed', false) === true) {
      announce();
      return;
    }
    el.ageGate.showModal();
    el.ageConfirm.addEventListener('click', () => {
      store.write('ageConfirmed', true);
      el.ageGate.close();
      announce();
    });
  }

  function announce() {
    socket.emit('hello', {
      clientId: store.clientId,
      country: el.myCountry.value,
      ageConfirmed: true,
      blocked: store.read('blocked', [])
    });
  }

  // ---------------------------------------------------------------- countries

  const COUNTRIES = [
    ['XX', 'Anywhere'], ['US', 'United States'], ['GB', 'United Kingdom'], ['CA', 'Canada'],
    ['AU', 'Australia'], ['IN', 'India'], ['DE', 'Germany'], ['FR', 'France'],
    ['ES', 'Spain'], ['IT', 'Italy'], ['NL', 'Netherlands'], ['PL', 'Poland'],
    ['SE', 'Sweden'], ['NO', 'Norway'], ['HU', 'Hungary'], ['TR', 'Turkey'],
    ['BR', 'Brazil'], ['MX', 'Mexico'], ['AR', 'Argentina'], ['JP', 'Japan'],
    ['KR', 'South Korea'], ['CN', 'China'], ['ID', 'Indonesia'], ['PH', 'Philippines'],
    ['PK', 'Pakistan'], ['BD', 'Bangladesh'], ['NG', 'Nigeria'], ['EG', 'Egypt'],
    ['ZA', 'South Africa'], ['RU', 'Russia'], ['UA', 'Ukraine'], ['VN', 'Vietnam']
  ];

  function fillCountries() {
    for (const [code, name] of COUNTRIES) {
      const a = new Option(name, code);
      el.myCountry.add(a);
      if (code !== 'XX') el.targets.add(new Option(name, code));
    }
    const saved = store.read('country', null);
    el.myCountry.value = saved || guessCountry();
  }

  // A rough guess from the browser locale — good enough for a default the user
  // can change, and it avoids asking for real geolocation.
  function guessCountry() {
    const locale = navigator.language || 'en-US';
    const region = locale.split('-')[1];
    if (region && COUNTRIES.some(([code]) => code === region.toUpperCase())) {
      return region.toUpperCase();
    }
    return 'XX';
  }

  // ---------------------------------------------------------------- filters

  function renderInterests() {
    el.interestTags.innerHTML = '';
    for (const tag of state.interests) {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = tag;
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', `Remove ${tag}`);
      x.addEventListener('click', () => {
        state.interests = state.interests.filter((t) => t !== tag);
        store.write('interests', state.interests);
        renderInterests();
      });
      chip.appendChild(x);
      el.interestTags.appendChild(chip);
    }
  }

  el.interestInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const raw = el.interestInput.value.toLowerCase().replace(/[^a-z0-9 ,-]/g, '');
    for (const part of raw.split(',')) {
      const tag = part.trim();
      if (tag && !state.interests.includes(tag) && state.interests.length < 6) {
        state.interests.push(tag);
      }
    }
    el.interestInput.value = '';
    store.write('interests', state.interests);
    renderInterests();
  });

  el.premium.addEventListener('change', () => {
    el.genderWrap.hidden = !el.premium.checked;
    store.write('premium', el.premium.checked);
  });

  el.autoCall.addEventListener('change', () => {
    state.autoCall = el.autoCall.checked;
    store.write('autoCall', state.autoCall);
  });

  el.captionsOn.addEventListener('change', () => {
    state.captions = el.captionsOn.checked;
    store.write('captions', state.captions);
    el.captionLangs.hidden = !state.captions;

    // Toggling mid-call takes effect immediately rather than next call.
    if (state.captions && state.phase !== 'idle' && state.mode === 'voice') startCaptions();
    if (!state.captions) stopCaptions();
  });

  el.myLanguage.addEventListener('change', () => {
    state.language = el.myLanguage.value;
    store.write('language', state.language);
  });

  el.translateTo.addEventListener('change', () => {
    state.translateTo = el.translateTo.value || null;
    store.write('translateTo', state.translateTo || '');
  });

  el.notify.addEventListener('change', async () => {
    const on = el.notify.checked;
    // Browsers only grant this from a user gesture, which a change event is.
    if (on && window.Notification && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    if (on && window.Notification && Notification.permission === 'denied') {
      toast('Notifications are blocked in your browser settings', 'err');
    }
    store.write('notify', on);
    socket.emit('notify', { on });
  });

  el.myCountry.addEventListener('change', () => {
    store.write('country', el.myCountry.value);
    announce();
  });


  // ------------------------------------------------------------ call history

  function pushHistory(entry) {
    const list = store.read('history', []);
    list.unshift(entry);
    store.write('history', list.slice(0, 5));
    renderHistory();
  }

  /** Shared row builder so the two lists cannot drift apart visually. */
  function listRow(name, sub) {
    const row = document.createElement('div');
    row.className = 'list-item';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = (name || '?').charAt(0);

    const body = document.createElement('div');
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = name;
    body.appendChild(nm);

    if (sub) {
      const meta = document.createElement('div');
      meta.className = 'sub';
      meta.textContent = sub;
      body.appendChild(meta);
    }

    row.append(avatar, body);
    return row;
  }

  function renderEmpty(target, message) {
    target.innerHTML = '';
    const note = document.createElement('p');
    note.className = 'empty';
    note.textContent = message;
    target.appendChild(note);
  }

  function renderHistory() {
    const list = store.read('history', []);
    if (!list.length) {
      renderEmpty(el.history, 'Your recent conversations will show up here.');
      return;
    }
    el.history.innerHTML = '';
    for (const item of list) {
      const when = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      el.history.appendChild(
        listRow(item.name, `${countryLabel(item.country)} · ${when} · ${formatDuration(item.duration)}`)
      );
    }
  }

  function renderFriends(names) {
    if (!names || !names.length) {
      renderEmpty(el.friends, 'Add someone during a call and they will appear here.');
      return;
    }
    el.friends.innerHTML = '';
    for (const name of names) el.friends.appendChild(listRow(name, null));
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.round((ms || 0) / 1000));
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  // -------------------------------------------------------------- microphone

  async function ensureMic() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    setupAudioGraph(localStream);
    return localStream;
  }

  function setupAudioGraph(stream) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    estimateGender();
  }

  // Voice-pitch gender estimate. Runs entirely in this browser on the local
  // mic, samples for a few seconds, and never leaves the device except as the
  // single word "male" / "female" / "unknown" sent with the match request.
  function estimateGender() {
    const buf = new Float32Array(analyser.fftSize);
    const samples = [];
    let ticks = 0;

    const tick = () => {
      if (!analyser || ticks++ > 40) {
        if (samples.length >= 6) {
          samples.sort((a, b) => a - b);
          const median = samples[Math.floor(samples.length / 2)];
          state.myGender = median < 165 ? 'male' : 'female';
        }
        return;
      }
      analyser.getFloatTimeDomainData(buf);
      const f0 = detectPitch(buf, audioCtx.sampleRate);
      if (f0 > 60 && f0 < 400) samples.push(f0);
      setTimeout(tick, 120);
    };
    tick();
  }

  // Autocorrelation pitch detection — enough for a coarse male/female split.
  function detectPitch(buf, sampleRate) {
    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / buf.length);
    if (rms < 0.01) return -1; // silence

    const minLag = Math.floor(sampleRate / 400);
    const maxLag = Math.floor(sampleRate / 60);
    let bestLag = -1;
    let bestCorr = 0;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      for (let i = 0; i < buf.length - lag; i++) corr += buf[i] * buf[i + lag];
      corr /= buf.length - lag;
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    return bestLag > 0 ? sampleRate / bestLag : -1;
  }

  // ------------------------------------------------------------ visualiser

  function buildViz() {
    for (let i = 0; i < 44; i++) el.viz.appendChild(document.createElement('i'));
  }

  function runViz() {
    if (!analyser) return;
    const bars = el.viz.querySelectorAll('i');
    const data = new Uint8Array(analyser.frequencyBinCount);

    const frame = () => {
      analyser.getByteFrequencyData(data);
      const step = Math.floor(data.length / bars.length);
      bars.forEach((bar, i) => {
        const v = data[i * step] / 255;
        bar.style.height = Math.max(6, v * 60) + 'px';
        bar.style.opacity = String(0.22 + v * 0.78);
      });
      vizRaf = requestAnimationFrame(frame);
    };
    frame();
  }

  function stopViz() {
    if (vizRaf) cancelAnimationFrame(vizRaf);
    vizRaf = null;
    el.viz.querySelectorAll('i').forEach((bar) => {
      bar.style.height = '6px';
      bar.style.opacity = '0.22';
    });
  }

  // ------------------------------------------------------------- captions

  // Each clip is recorded as a self-contained file rather than a slice of a
  // longer stream: a mid-stream WebM fragment has no header and cannot be
  // decoded on its own, so the transcriber would reject it.
  const CLIP_MS = 4000;
  let clipTimer = null;

  function fillLanguages(languages) {
    const entries = Object.entries(languages);
    if (!entries.length) return;
    for (const [code, label] of entries) {
      el.myLanguage.add(new Option(label, code));
      el.translateTo.add(new Option(label, code));
    }
    el.myLanguage.value = store.read('language', guessLanguage(languages));
    el.translateTo.value = store.read('translateTo', '') || '';
  }

  function guessLanguage(languages) {
    const code = (navigator.language || 'en').split('-')[0].toLowerCase();
    return languages[code] ? code : 'en';
  }

  function startCaptions() {
    if (clipTimer || !localStream || !state.captions) return;

    // Ogg first: it is an Opus container the speech providers accept as-is.
    // Chrome only offers WebM, which the server relabels — same Opus payload,
    // different wrapper — so both paths work.
    const mime = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find((type) => window.MediaRecorder?.isTypeSupported(type));
    if (!mime) {
      toast('This browser cannot record audio for captions', 'err');
      return;
    }

    const captureOnce = () => {
      if (!localStream || !state.captions) return;
      let recorder;
      try {
        recorder = new MediaRecorder(localStream, { mimeType: mime });
      } catch {
        return;
      }
      const parts = [];
      recorder.ondataavailable = (event) => { if (event.data.size) parts.push(event.data); };
      recorder.onstop = async () => {
        const blob = new Blob(parts, { type: mime });
        // Anything this small is silence or a truncated clip.
        if (blob.size < 2000) return;
        socket.emit('voice:clip', { chunk: await blob.arrayBuffer(), mimeType: mime });
      };
      recorder.start();
      setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, CLIP_MS);
    };

    captureOnce();
    clipTimer = setInterval(captureOnce, CLIP_MS + 400);
    el.captionBar.hidden = false;
  }

  function stopCaptions() {
    if (clipTimer) clearInterval(clipTimer);
    clipTimer = null;
    el.captionBar.hidden = true;
    el.captionThem.textContent = '';
    el.captionMe.textContent = '';
  }

  // --------------------------------------------------------------- WebRTC

  async function createPeer() {
    closePeer();
    pendingCandidates = [];
    pc = new RTCPeerConnection({ iceServers: state.iceServers, iceCandidatePoolSize: 4 });

    if (localStream) {
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) socket.emit('signal', { data: { candidate: event.candidate } });
    };

    pc.ontrack = (event) => {
      el.remote.srcObject = event.streams[0];
      el.remote.play().catch(() => { /* autoplay policy — user gesture already happened */ });
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') {
        setStatus(`Connected to <strong>${escapeHtml(state.partner?.name || 'someone')}</strong>`);
      }
      if (pc.connectionState === 'failed') {
        toast('Connection failed — trying the next person', 'err');
        endCall('failed');
      }
    };

    return pc;
  }

  function closePeer() {
    if (!pc) return;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
    el.remote.srcObject = null;
  }

  async function startOffer() {
    await createPeer();
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    socket.emit('signal', { data: { sdp: pc.localDescription } });
  }

  async function handleSignal({ data }) {
    if (!data) return;

    if (data.sdp) {
      if (!pc) await createPeer();
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

      // Candidates can beat the answer here; replay whatever arrived early.
      for (const candidate of pendingCandidates) {
        await pc.addIceCandidate(candidate).catch(() => {});
      }
      pendingCandidates = [];

      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { data: { sdp: pc.localDescription } });
      }
      return;
    }

    if (data.candidate) {
      const candidate = new RTCIceCandidate(data.candidate);
      if (pc?.remoteDescription?.type) {
        await pc.addIceCandidate(candidate).catch(() => {});
      } else {
        pendingCandidates.push(candidate);
      }
    }
  }

  // ------------------------------------------------------------ call control

  async function startSearch() {
    state.mode = el.mode.value;

    if (state.mode === 'voice') {
      try {
        await ensureMic();
        if (audioCtx?.state === 'suspended') await audioCtx.resume();
      } catch {
        toast('Microphone access is required for voice chat', 'err');
        setStatus('Microphone blocked. Allow it in your browser, or switch to text chat.');
        return;
      }
    }

    state.phase = 'searching';
    paintPhase();
    setStatus('Looking for someone…');

    socket.emit('find', {
      mode: state.mode,
      countries: [...el.targets.selectedOptions].map((o) => o.value),
      interests: state.interests,
      premium: el.premium.checked,
      genderPreference: el.genderPref.value,
      gender: state.myGender,
      captions: state.captions,
      language: state.language,
      translateTo: state.translateTo
    });
  }

  function endCall(reason) {
    if (state.roomId) {
      pushHistory({
        name: state.partner?.name || 'Stranger',
        country: state.partner?.country || 'XX',
        at: Date.now(),
        duration: Date.now() - state.startedAt
      });
    }
    closePeer();
    stopViz();
    stopCaptions();
    stopTimer();
    el.queueNote.hidden = true;
    state.phase = 'idle';
    state.roomId = null;
    state.partner = null;
    el.partnerCard.classList.remove('show');
    el.gameWrap.hidden = true;
    paintPhase();

    if (reason === 'skipped') systemMessage('You skipped to the next person.');
    if (reason === 'partner') systemMessage('The other person left.');

    if (state.autoCall && reason !== 'manual') {
      setTimeout(() => { if (state.phase === 'idle') startSearch(); }, 900);
    }
  }

  function startTimer() {
    state.startedAt = Date.now();
    stopTimer();
    timerId = setInterval(() => {
      el.timer.textContent = formatDuration(Date.now() - state.startedAt);
    }, 1000);
  }

  function stopTimer() {
    if (timerId) clearInterval(timerId);
    timerId = null;
    el.timer.textContent = '';
  }

  function paintPhase() {
    const live = state.phase === 'matched' || state.phase === 'live';
    const searching = state.phase === 'searching';

    el.callBtn.classList.toggle('searching', searching);
    el.callBtn.classList.toggle('live', live);
    el.callCap.textContent = live ? 'Hang up' : searching ? 'Cancel' : 'Call';
    el.callBtn.setAttribute(
      'aria-label',
      live ? 'Hang up the call' : searching ? 'Cancel searching' : 'Call a stranger'
    );

    // An idle screen shows no call controls at all. Disabled buttons are just
    // clutter that tells you what you cannot do.
    el.controls.hidden = !live;
    el.mute.hidden = state.mode !== 'voice';
    el.voice.hidden = state.mode !== 'text';
    if (!live) closeMoreMenu();

    el.chatInput.disabled = !live;
    el.send.disabled = !live;
    el.image.disabled = !live;

    if (state.phase === 'idle') setStatus('Press call to meet someone new.');
  }

  el.callBtn.addEventListener('click', () => {
    if (state.phase === 'idle') return startSearch();
    if (state.phase === 'searching') {
      socket.emit('cancel');
      state.phase = 'idle';
      paintPhase();
      return;
    }
    socket.emit('leave');
    endCall('manual');
  });

  el.next.addEventListener('click', () => {
    socket.emit('next');
    endCall('skipped');
    startSearch();
  });

  el.mute.addEventListener('click', () => {
    if (!localStream) return;
    state.muted = !state.muted;
    for (const track of localStream.getAudioTracks()) track.enabled = !state.muted;
    el.mute.classList.toggle('active', state.muted);
    // Icon-only button, so the state has to live in the label, not the text.
    const label = state.muted ? 'Unmute' : 'Mute';
    el.mute.title = label;
    el.mute.setAttribute('aria-label', label);
  });

  el.voice.addEventListener('click', async () => {
    try {
      await ensureMic();
      socket.emit('escalate');
      toast('Asked to switch to voice');
    } catch {
      toast('Microphone access is required', 'err');
    }
  });

  el.friend.addEventListener('click', () => {
    socket.emit('friend:request');
    toast('Friend request sent');
  });

  el.block.addEventListener('click', () => {
    closeMoreMenu();
    socket.emit('block');
    toast('Blocked — you will not be matched again', 'ok');
  });

  el.report.addEventListener('click', () => {
    closeMoreMenu();
    el.reportModal.showModal();
  });
  el.reportCancel.addEventListener('click', () => el.reportModal.close());
  el.reportSend.addEventListener('click', () => {
    socket.emit('report', { reason: el.reportReason.value });
    el.reportModal.close();
  });

  // ----------------------------------------------------------------- chat UI

  function addMessage({ from, text, dataUrl }) {
    el.chatLog.querySelector('.chat-empty')?.remove();
    const node = document.createElement('div');
    node.className = 'msg ' + from;
    if (dataUrl) {
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = 'Shared image';
      node.appendChild(img);
    } else {
      node.textContent = text;
    }
    el.chatLog.appendChild(node);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  function sendChat() {
    const text = el.chatInput.value.trim();
    if (!text) return;
    socket.emit('chat', { text });
    el.chatInput.value = '';
    socket.emit('typing', { on: false });
  }

  el.send.addEventListener('click', sendChat);
  el.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
  });

  let typingTimer = null;
  el.chatInput.addEventListener('input', () => {
    socket.emit('typing', { on: true });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => socket.emit('typing', { on: false }), 1400);
  });

  el.image.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', async () => {
    const file = el.file.files?.[0];
    el.file.value = '';
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) {
      toast('Image must be under 3 MB', 'err');
      return;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    socket.emit('image', { dataUrl });
  });

  // -------------------------------------------------------------------- game

  function renderBoard(payload) {
    el.gameWrap.hidden = false;
    el.board.innerHTML = '';
    payload.board.forEach((cell, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = cell || '';
      btn.disabled = Boolean(cell) || !payload.yourTurn || payload.finished;
      btn.addEventListener('click', () => socket.emit('game:move', { cell: index }));
      el.board.appendChild(btn);
    });

    if (payload.finished) {
      el.gameStatus.textContent = payload.winner
        ? (payload.winner === payload.yourMark ? 'You won.' : 'They won.')
        : 'A draw.';
    } else {
      el.gameStatus.textContent = payload.yourTurn
        ? `Your turn — you are ${payload.yourMark}`
        : 'Waiting for them…';
    }
  }

  el.game.addEventListener('click', () => socket.emit('game:start'));

  // ---------------------------------------------------------- socket events

  socket.on('ready', (payload) => {
    state.iceServers = payload.iceServers || [];
    paintStats(payload.stats);

    // Caption controls only exist if the server can actually transcribe.
    state.voiceFeatures = payload.voiceFeatures === true;
    el.captionSettings.hidden = !state.voiceFeatures;
    if (state.voiceFeatures) fillLanguages(payload.languages || {});
  });

  socket.on('hello:ok', (payload) => {
    // The server list is authoritative — it survives clearing this browser.
    const names = (payload?.friends || []).map((friend) => friend.name);
    if (names.length) store.write('friendNames', names);
    renderFriends(names.length ? names : store.read('friendNames', []));

    if (payload && payload.persistent === false) {
      systemMessage('Running without a database — friends and blocks will not survive a restart.');
    }
  });

  socket.on('stats', paintStats);

  function paintStats(s) {
    if (!s) return;
    el.online.textContent = s.online.toLocaleString();
    el.calls.textContent = s.inCall.toLocaleString();
  }

  socket.on('waiting', (payload = {}) => {
    // A bare spinner reads as "broken" on a quiet server. Say what is actually
    // happening: how many people are queued, and which filter was relaxed.
    const others = Math.max(0, (payload.queued || 1) - 1);
    setStatus(others > 0
      ? `Looking… ${others} other ${others === 1 ? 'person is' : 'people are'} waiting too`
      : 'Looking for someone…');

    const seconds = Math.floor((payload.waitedMs || 0) / 1000);
    const parts = [];
    if (seconds >= 5) parts.push(`waiting ${seconds}s`);
    if (payload.online) parts.push(`${payload.online} online`);

    let note = parts.join(' · ');
    if (payload.relaxedLabel) {
      note += `${note ? ' — ' : ''}<span class="relaxed">widened search, ignoring your ${payload.relaxedLabel}</span>`;
    }
    el.queueNote.innerHTML = note;
    el.queueNote.hidden = !note;
  });

  socket.on('someone:waiting', () => {
    if (state.phase !== 'idle') return;
    toast('Someone is looking for a call');
    if (window.Notification?.permission === 'granted') {
      new Notification('Friends Talk', { body: 'Someone is looking for a call right now.' });
    }
  });

  socket.on('matched', async (payload) => {
    state.phase = 'matched';
    state.roomId = payload.roomId;
    state.mode = payload.mode;
    state.initiator = payload.initiator;
    state.partner = payload.partner;

    el.chatLog.innerHTML = '';
    el.partnerCard.classList.add('show');
    el.partnerName.textContent = payload.partner.name;
    el.partnerInitial.textContent = payload.partner.name.charAt(0);
    el.partnerSub.textContent = countryLabel(payload.partner.country) +
      (payload.sharedInterests.length ? ' · shares ' + payload.sharedInterests.join(', ') : '');

    paintPhase();
    startTimer();
    systemMessage(`You are now talking with ${payload.partner.name}.`);

    el.queueNote.hidden = true;

    if (state.mode === 'voice') {
      setStatus('Connecting audio…');
      runViz();
      if (state.captions) startCaptions();
      if (payload.initiator) await startOffer();
    } else {
      setStatus(`Text chat with <strong>${escapeHtml(payload.partner.name)}</strong>`);
    }
  });

  socket.on('signal', handleSignal);

  socket.on('chat', (message) => addMessage(message));

  socket.on('chat:blocked', ({ reason }) => {
    addMessage({ from: 'warn', text: `Message not delivered — it was flagged as ${humanReason(reason)}.` });
  });

  socket.on('chat:warning', ({ reason }) => {
    addMessage({ from: 'warn', text: reason === 'contact_details'
      ? 'Careful: sharing contact details with a stranger is risky.'
      : 'That message was flagged for review.' });
  });

  socket.on('image:pending', () => systemMessage('Screening image…'));
  socket.on('image', (payload) => addMessage({ from: payload.from, dataUrl: payload.dataUrl }));
  socket.on('image:blocked', ({ reason }) => {
    addMessage({ from: 'warn', text: `Image blocked by moderation (${humanReason(reason)}).` });
  });

  socket.on('typing', ({ on }) => {
    el.typing.textContent = on ? `${state.partner?.name || 'They'} is typing…` : '';
  });

  socket.on('escalate:request', () => {
    if (!confirm(`${state.partner?.name || 'They'} wants to switch to a voice call. Accept?`)) return;
    ensureMic()
      .then(() => socket.emit('escalate:accept'))
      .catch(() => toast('Microphone access is required', 'err'));
  });

  socket.on('escalate:accepted', async ({ initiator }) => {
    state.mode = 'voice';
    paintPhase();
    runViz();
    if (state.captions) startCaptions();
    setStatus('Switching to voice…');
    if (initiator) await startOffer();
  });

  socket.on('caption', (payload = {}) => {
    const target = payload.from === 'me' ? el.captionMe : el.captionThem;
    target.textContent = payload.from === 'me' ? `You: ${payload.text}` : payload.text;
    if (payload.original) {
      const note = document.createElement('span');
      note.className = 'lang-note';
      note.textContent = `(${payload.original})`;
      target.appendChild(note);
    }
  });

  socket.on('voice:warning', ({ reason, strikes, limit }) => {
    toast(`Warning ${strikes}/${limit}: ${humanReason(reason)} is not allowed`, 'err');
    addMessage({
      from: 'warn',
      text: `That was flagged as ${humanReason(reason)}. Warning ${strikes} of ${limit}.`
    });
  });

  socket.on('game:state', renderBoard);

  socket.on('friend:request', ({ name }) => {
    if (confirm(`${name} wants to add you as a friend. Accept?`)) socket.emit('friend:accept');
  });

  socket.on('friend:added', ({ name }) => {
    const names = store.read('friendNames', []);
    if (!names.includes(name)) names.push(name);
    store.write('friendNames', names);
    renderFriends(names);
    toast(`${name} added to friends`, 'ok');
  });

  socket.on('blocked:ok', ({ clientId }) => {
    if (!clientId) return;
    const blocked = store.read('blocked', []);
    if (!blocked.includes(clientId)) blocked.push(clientId);
    store.write('blocked', blocked);
    announce();
  });

  socket.on('report:ok', () => toast('Report submitted — thank you', 'ok'));

  socket.on('partner:left', () => endCall('partner'));

  socket.on('room:closed', () => { /* local endCall already handled the UI */ });

  socket.on('error:blocked', ({ reason }) => {
    if (reason === 'age_not_confirmed') {
      el.ageGate.showModal();
      return;
    }
    if (reason === 'suspended') {
      endCall('manual');
      setStatus('This device is suspended after multiple reports. Try again later.');
      toast('Suspended after multiple reports', 'err');
    }
  });

  socket.on('disconnect', () => {
    setStatus('Disconnected from the server. Reconnecting…');
    endCall('failed');
  });

  // ------------------------------------------------------------------ utils

  function countryLabel(code) {
    const found = COUNTRIES.find(([c]) => c === code);
    return found ? found[1] : 'Somewhere';
  }

  function humanReason(reason) {
    const map = {
      hate_or_harassment: 'hate speech or harassment',
      sexual_content: 'sexual content',
      possible_minor: 'a possible minor',
      contact_details: 'contact details',
      too_long: 'too long',
      too_large: 'too large',
      unsupported_type: 'an unsupported file type',
      malformed_image: 'an invalid image'
    };
    return map[reason] || reason;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  // ------------------------------------------------------------- panel toggles

  $('toggle-left').addEventListener('click', () => $('pane-left').classList.toggle('is-open'));
  $('toggle-right').addEventListener('click', () => $('pane-right').classList.toggle('is-open'));

  // Sidebar tabs — filters, recent calls, and friends share one column instead
  // of stacking into a page-length scroll.
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) {
        other.classList.toggle('is-active', other === tab);
      }
      for (const panel of document.querySelectorAll('.panel')) {
        panel.classList.toggle('is-active', panel.id === tab.dataset.panel);
      }
    });
  }

  // Report and block live behind an overflow menu. They should be reachable in
  // one tap but not sit next to Mute inviting a misclick.
  function closeMoreMenu() {
    el.moreMenu.hidden = true;
    el.moreBtn.setAttribute('aria-expanded', 'false');
  }

  el.moreBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = el.moreMenu.hidden;
    el.moreMenu.hidden = !open;
    el.moreBtn.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.overflow')) closeMoreMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMoreMenu();
  });

  // ------------------------------------------------------------------- boot

  function boot() {
    buildViz();
    fillCountries();

    state.interests = store.read('interests', []);
    state.autoCall = store.read('autoCall', false);
    el.autoCall.checked = state.autoCall;
    el.premium.checked = store.read('premium', false);
    el.genderWrap.hidden = !el.premium.checked;

    state.captions = store.read('captions', false);
    el.captionsOn.checked = state.captions;
    el.captionLangs.hidden = !state.captions;
    state.language = store.read('language', 'en');
    state.translateTo = store.read('translateTo', '') || null;
    el.notify.checked = store.read('notify', false);

    const requested = new URLSearchParams(location.search).get('mode');
    el.mode.value = requested === 'text' ? 'text' : (store.read('mode', 'voice'));
    state.mode = el.mode.value;

    renderInterests();
    renderHistory();
    renderFriends(store.read('friendNames', []));
    paintPhase();
    bootAgeGate();
  }

  boot();
})();

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
    translateTo: null,
    groupRoom: null,
    groupCapacity: 5,
    selfName: 'You',
    speakIncoming: false,
    speakTyped: false,
    callbackToken: null
  };

  let pc = null;
  let localStream = null;
  let audioCtx = null;
  let analyser = null;
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
    captionThem: $('caption-them'), captionMe: $('caption-me'),
    roster: $('roster'), rosterHead: $('roster-head'), rosterList: $('roster-list'),
    modeHint: $('mode-hint'), screenSupportHint: $('screen-support-hint'),
    speakIncoming: $('speak-incoming'), speakTyped: $('speak-typed'),
    speechHint: $('speech-hint'),
    ringModal: $('ring-modal'), ringName: $('ring-name'), ringSub: $('ring-sub'),
    ringAvatar: $('ring-avatar'), ringAccept: $('ring-accept'), ringDecline: $('ring-decline'),
    padBtn: $('btn-pad'), padWrap: $('pad-wrap'), padText: $('pad-text'), padNote: $('pad-note'),
    screenBtn: $('btn-screen'), screenWrap: $('screen-wrap'), screenVideo: $('screen-video'),
    screenLabel: $('screen-label'), screenStop: $('screen-stop'), screenReport: $('screen-report'),
    screenFull: $('screen-full'), screenFullLabel: $('screen-full-label'),
    screenMaximize: $('screen-maximize'),
    screenModal: $('screen-modal'), screenAskTitle: $('screen-ask-title'),
    screenAskBody: $('screen-ask-body'), screenAskAccept: $('screen-ask-accept'),
    screenAskDecline: $('screen-ask-decline')
  };

  // The mode picker is a segmented control rather than a <select>, because a
  // binary choice should not be a dropdown. This shim lets the rest of the file
  // keep reading and writing `el.mode.value` as though nothing changed.
  const modeSeg = $('mode-seg');

  const MODE_HINTS = {
    voice: 'One-to-one voice call with a stranger.',
    text: 'Start by typing. Either of you can switch it to voice later.',
    group: 'Join a small room of up to 5 people. Opens one if none has space.'
  };

  function setMode(next) {
    for (const seg of modeSeg.querySelectorAll('.seg')) {
      const on = seg.dataset.mode === next;
      seg.classList.toggle('is-active', on);
      seg.setAttribute('aria-checked', String(on));
    }
    state.mode = next;
    store.write('mode', next);
    if (el.modeHint) el.modeHint.textContent = MODE_HINTS[next] || '';
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

  const ICON_CALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 11a7 7 0 0 1-14 0"/></svg>';
  const ICON_BLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>';

  /**
   * Shared row builder so the two lists cannot drift apart visually.
   *
   * `target` identifies who the row is about: a friend carries a client id
   * (exchanged by mutual consent), while someone from the recent list carries
   * only an opaque token, so calling them back never reveals who they are.
   */
  function listRow(name, sub, target) {
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

    if (target && (target.token || target.clientId)) {
      const actions = document.createElement('div');
      actions.className = 'actions';

      const call = document.createElement('button');
      call.className = 'row-btn call';
      call.type = 'button';
      call.title = `Call ${name}`;
      call.setAttribute('aria-label', `Call ${name}`);
      call.innerHTML = ICON_CALL;
      call.addEventListener('click', () => ringPerson({ ...target, name }));

      const block = document.createElement('button');
      block.className = 'row-btn block';
      block.type = 'button';
      block.title = `Block ${name}`;
      block.setAttribute('aria-label', `Block ${name}`);
      block.innerHTML = ICON_BLOCK;
      block.addEventListener('click', () => {
        if (!confirm(`Block ${name}? You will never be matched with them again.`)) return;
        socket.emit('block:client', target);
        removeFromLists(target);
        toast(`${name} blocked`, 'ok');
      });

      actions.append(call, block);
      row.appendChild(actions);
    }
    return row;
  }

  /** Drops a blocked person from both local lists straight away. */
  function removeFromLists(target) {
    const history = store.read('history', [])
      .filter((item) => !(target.token && item.token === target.token));
    store.write('history', history);

    if (target.clientId) {
      const friends = store.read('friendList', [])
        .filter((f) => f.clientId !== target.clientId);
      store.write('friendList', friends);
    }
    renderHistory();
    renderFriends(store.read('friendList', []));
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
      el.history.appendChild(listRow(
        item.name,
        `${countryLabel(item.country)} · ${when} · ${formatDuration(item.duration)}`,
        item.token ? { token: item.token } : null
      ));
    }
  }

  function renderFriends(friends) {
    if (!friends || !friends.length) {
      renderEmpty(el.friends, 'Add someone during a call and they will appear here.');
      return;
    }
    el.friends.innerHTML = '';
    for (const friend of friends) {
      el.friends.appendChild(listRow(
        friend.name,
        null,
        friend.clientId ? { clientId: friend.clientId } : null
      ));
    }
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

  /**
   * Autocorrelation pitch detection — enough for a coarse male/female split.
   *
   * Done naively this is the most expensive thing on the main thread: every lag
   * from 60 Hz to 400 Hz correlated across the full 2048-sample window is well
   * over a million multiply-adds, repeated every 120 ms while the analyser is
   * also feeding the visualiser.
   *
   * Two changes make it cheap without changing the answer. The window is halved
   * — one period of even a low voice fits comfortably in 1024 samples — and the
   * lag search runs coarse then refines around the winner, instead of walking
   * every lag at full resolution. That is roughly an eightfold reduction, and
   * the result still lands in the right half of the male/female split.
   */
  function detectPitch(buf, sampleRate) {
    const n = Math.min(buf.length, 1024);

    let rms = 0;
    for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
    if (Math.sqrt(rms / n) < 0.01) return -1; // silence

    const minLag = Math.floor(sampleRate / 400);
    const maxLag = Math.min(Math.floor(sampleRate / 60), n - 1);

    const correlate = (lag) => {
      let sum = 0;
      const end = n - lag;
      for (let i = 0; i < end; i++) sum += buf[i] * buf[i + lag];
      return sum / end;
    };

    let bestLag = -1;
    let bestCorr = 0;
    const COARSE = 4;
    for (let lag = minLag; lag <= maxLag; lag += COARSE) {
      const corr = correlate(lag);
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    if (bestLag < 0) return -1;

    // Refine within the coarse step that won.
    const from = Math.max(minLag, bestLag - COARSE);
    const to = Math.min(maxLag, bestLag + COARSE);
    for (let lag = from; lag <= to; lag++) {
      const corr = correlate(lag);
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    return sampleRate / bestLag;
  }

  // --------------------------------------------------------- frame driver

  /**
   * One requestAnimationFrame loop for the whole app.
   *
   * The visualiser and the speaking indicator both want per-frame work, and
   * during a group call both were running their own loop. Two loops means two
   * callbacks, two chances to overrun the frame budget, and no shared control
   * over when to stop. This is one loop with a task set.
   *
   * It also stops entirely when the tab is hidden. A backgrounded tab still
   * gets throttled callbacks, and doing audio analysis for a visualiser nobody
   * can see is pure waste on a phone battery.
   */
  const frameTasks = new Set();
  let frameHandle = null;

  function startFrames() {
    if (frameHandle !== null || document.hidden || frameTasks.size === 0) return;
    const loop = () => {
      for (const task of frameTasks) task();
      frameHandle = requestAnimationFrame(loop);
    };
    frameHandle = requestAnimationFrame(loop);
  }

  function stopFrames() {
    if (frameHandle !== null) cancelAnimationFrame(frameHandle);
    frameHandle = null;
  }

  function addFrameTask(task) {
    frameTasks.add(task);
    startFrames();
  }

  function removeFrameTask(task) {
    frameTasks.delete(task);
    if (frameTasks.size === 0) stopFrames();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopFrames();
    else startFrames();
  });

  // ------------------------------------------------------------ visualiser

  function buildViz() {
    for (let i = 0; i < 44; i++) el.viz.appendChild(document.createElement('i'));
  }

  let vizBars = null;
  let vizData = null;

  /**
   * Drives the bars with transform rather than height.
   *
   * Writing `height` on 44 elements every frame forces the browser to lay the
   * row out 44 times a second; `transform: scaleY()` is handled by the
   * compositor and touches neither layout nor paint. Same picture, a fraction
   * of the work — which is what a mid-range phone actually notices.
   */
  function vizFrame() {
    if (!analyser) return;
    analyser.getByteFrequencyData(vizData);
    const step = Math.floor(vizData.length / vizBars.length) || 1;
    for (let i = 0; i < vizBars.length; i++) {
      const v = vizData[i * step] / 255;
      // Never fully collapse — a zero-scale bar disappears rather than resting.
      vizBars[i].style.transform = `scaleY(${(0.08 + v * 0.92).toFixed(3)})`;
    }
  }

  function runViz() {
    if (!analyser) return;
    vizBars = [...el.viz.querySelectorAll('i')];
    vizData = new Uint8Array(analyser.frequencyBinCount);
    el.viz.classList.add('is-live');
    addFrameTask(vizFrame);
  }

  function stopViz() {
    removeFrameTask(vizFrame);
    el.viz.classList.remove('is-live');
    for (const bar of el.viz.querySelectorAll('i')) bar.style.transform = 'scaleY(0.08)';
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
      // The same connection now carries two kinds of track, so this can no
      // longer assume everything arriving is the voice stream.
      if (event.track.kind === 'video') {
        showRemoteScreen(new MediaStream([event.track]));
        event.track.addEventListener('ended', hideRemoteScreen);
        return;
      }
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

  // ---------------------------------------------------------- screen share

  /**
   * Sharing a screen over the existing call.
   *
   * Adding a track to a live peer connection does not take effect on its own —
   * the connection has to be renegotiated with a fresh offer. Only the person
   * sharing ever starts that renegotiation, so the two sides can never send
   * each other an offer at the same time.
   *
   * The receiver must agree first. Everywhere else in this app the visual
   * channel is closed, which is exactly why it is safer than camera roulette;
   * opening it for a stranger is not something that should happen without them
   * saying yes.
   */
  let screenStream = null;
  let screenSender = null;
  let watchingScreen = false;

  /**
   * Whether this device can *send* a screen.
   *
   * getDisplayMedia does not exist on any mobile browser — not iOS Safari, not
   * Chrome or Firefox on Android, and not Chrome for iOS, which is Safari's
   * engine wearing a different badge. Apple and Google do not expose screen
   * capture to web pages on phones at all, so there is nothing to fall back to.
   *
   * Receiving is unaffected: a phone plays an incoming screen perfectly well.
   * So the control to start a share is hidden rather than left to fail, and the
   * viewer path stays fully available on mobile.
   */
  function screenSupported() {
    return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  }

  function isMobileBrowser() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)); // iPadOS
  }

  el.screenBtn.addEventListener('click', () => {
    if (screenStream) return stopSharing('manual');
    if (!pc || pc.connectionState !== 'connected') {
      toast('Wait until the call is connected', 'err');
      return;
    }
    if (!screenSupported()) {
      toast('This browser cannot share a screen', 'err');
      return;
    }
    socket.emit('screen:request');
    toast('Asked to share your screen');
    el.screenBtn.disabled = true;
    setTimeout(() => { el.screenBtn.disabled = false; }, 4000);
  });

  // They asked to show us their screen.
  socket.on('screen:request', ({ name }) => {
    el.screenAskTitle.textContent = `Let ${name} share their screen?`;
    el.screenAskBody.textContent =
      `${name} wants to show you their screen. You can stop watching at any time.`;
    if (!el.screenModal.open) el.screenModal.showModal();
  });

  el.screenAskAccept.addEventListener('click', () => {
    el.screenModal.close();
    socket.emit('screen:accept');
  });

  el.screenAskDecline.addEventListener('click', () => {
    el.screenModal.close();
    socket.emit('screen:decline');
  });

  socket.on('screen:declined', () => {
    el.screenBtn.disabled = false;
    toast('They declined the screen share', 'err');
  });

  // They agreed — pick a surface and renegotiate the connection.
  socket.on('screen:accepted', async () => {
    el.screenBtn.disabled = false;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 12 },   // plenty for a document, far cheaper than 30
        audio: false
      });
    } catch {
      toast('Screen share cancelled');
      socket.emit('screen:stopped');
      return;
    }

    const [track] = screenStream.getVideoTracks();
    // Stopping from the browser's own "stop sharing" bar must tear down too.
    track.addEventListener('ended', () => stopSharing('browser'));

    screenSender = pc.addTrack(track, screenStream);
    await renegotiate();

    showLocalScreen();
    toast('Sharing your screen', 'ok');
  });

  /**
   * Fresh offer after the track set changed.
   *
   * Only ever called by the side that is sharing, which is what keeps this from
   * colliding with the other peer doing the same thing.
   */
  async function renegotiate() {
    if (!pc) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { data: { sdp: pc.localDescription } });
  }

  async function stopSharing(reason) {
    if (!screenStream) return;
    for (const track of screenStream.getTracks()) track.stop();
    if (screenSender && pc) {
      try { pc.removeTrack(screenSender); } catch { /* connection already gone */ }
      await renegotiate();
    }
    screenStream = null;
    screenSender = null;
    hideLocalScreen();
    socket.emit('screen:stopped');
    if (reason !== 'teardown') toast('Stopped sharing your screen');
  }

  /**
   * The sharer sees their own screen at the same size the watcher does.
   *
   * Checking what the other person is actually getting — and being able to
   * blow it up to confirm it is legible — is worth as much to the person
   * sharing as to the person watching. Only the report button is withheld,
   * since reporting your own screen means nothing.
   */
  function showLocalScreen() {
    el.screenWrap.hidden = false;
    el.screenWrap.classList.add('is-sharing');
    el.screenWrap.classList.remove('is-viewing');
    el.screenLabel.textContent = 'You are sharing your screen';
    el.screenReport.hidden = true;
    el.screenFull.hidden = false;
    el.screenVideo.srcObject = screenStream;
    el.screenBtn.classList.add('active');
    el.screenBtn.setAttribute('aria-pressed', 'true');
  }

  function hideLocalScreen() {
    if (watchingScreen) return; // still receiving theirs
    el.screenWrap.hidden = true;
    el.screenVideo.srcObject = null;
    el.screenBtn.classList.remove('active');
    el.screenBtn.setAttribute('aria-pressed', 'false');
  }

  /**
   * The watcher gets the same frame, plus the report button.
   *
   * Report is the one control that only makes sense here: this is the person
   * being shown something by someone else, and a live video stream has no
   * automated screening behind it.
   */
  function showRemoteScreen(stream) {
    watchingScreen = true;
    el.screenWrap.hidden = false;
    el.screenWrap.classList.add('is-viewing');
    el.screenWrap.classList.remove('is-sharing');
    el.screenLabel.textContent = `${state.partner?.name || 'They'} is sharing their screen`;
    el.screenReport.hidden = false;
    el.screenFull.hidden = false;
    el.screenVideo.srcObject = stream;
    toast('They started sharing — press maximize for a full view');
  }

  function hideRemoteScreen() {
    watchingScreen = false;
    if (screenStream) return showLocalScreen(); // ours is still going
    el.screenWrap.hidden = true;
    el.screenVideo.srcObject = null;
  }

  /**
   * Fullscreen for the shared screen.
   *
   * The wrapper is what goes fullscreen, not the video, so the live indicator
   * and the stop and report buttons stay on screen — filling the display should
   * never remove the controls that let someone get out or flag what they are
   * being shown.
   *
   * iOS Safari does not implement the Fullscreen API on ordinary elements, so
   * it falls back to the video element's own native fullscreen.
   */
  function fullscreenActive() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  }

  async function toggleScreenFullscreen() {
    try {
      if (fullscreenActive()) {
        await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
        return;
      }
      const target = el.screenWrap;
      if (target.requestFullscreen) await target.requestFullscreen({ navigationUI: 'hide' });
      else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen();
      else if (el.screenVideo.webkitEnterFullscreen) el.screenVideo.webkitEnterFullscreen();
      else toast('Fullscreen is not available in this browser', 'err');
    } catch {
      toast('Could not switch to fullscreen', 'err');
    }
  }

  function paintFullscreenButton() {
    const on = fullscreenActive();
    el.screenFullLabel.textContent = on ? 'Exit' : 'Fullscreen';
    el.screenFull.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen');
    el.screenFull.title = el.screenFullLabel.textContent;

    // The overlay control has to say the opposite thing once maximised, or it
    // reads as a second way to do what has already been done. The arrows point
    // outward to expand and inward to collapse, so the icon itself changes.
    el.screenMaximize.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Maximize screen to fullscreen');
    el.screenMaximize.title = on ? 'Exit fullscreen (or double-click)' : 'Maximize (or double-click)';
    el.screenMaximize.querySelector('path').setAttribute('d', on ? ICON_COLLAPSE : ICON_EXPAND);
  }

  const ICON_EXPAND = 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7';
  const ICON_COLLAPSE = 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7';

  el.screenFull.addEventListener('click', toggleScreenFullscreen);
  el.screenMaximize.addEventListener('click', toggleScreenFullscreen);
  // Double-click is the convention every video player uses, so people try it
  // before they look for a button.
  el.screenVideo.addEventListener('dblclick', toggleScreenFullscreen);
  document.addEventListener('fullscreenchange', paintFullscreenButton);
  document.addEventListener('webkitfullscreenchange', paintFullscreenButton);

  /** Leaving fullscreen behind after the stream ends would strand the user. */
  async function exitFullscreenIfActive() {
    if (!fullscreenActive()) return;
    try { await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.()); } catch { /* already gone */ }
  }

  socket.on('screen:stopped', () => {
    exitFullscreenIfActive();
    hideRemoteScreen();
  });

  el.screenStop.addEventListener('click', () => {
    if (screenStream) return stopSharing('manual');
    hideRemoteScreen();
    toast('Stopped watching');
  });

  // The only moderation path for a live screen is a human pressing this.
  el.screenReport.addEventListener('click', () => {
    if (!confirm('Report what they are showing? This ends the call and suspends them.')) return;
    socket.emit('screen:report');
    hideRemoteScreen();
    socket.emit('leave');
    endCall('manual');
    toast('Reported — they have been suspended', 'ok');
  });

  // -------------------------------------------------------- shared notepad

  /**
   * A scratch pad both sides type into.
   *
   * Two rules keep it from fighting the person using it. Outgoing edits are
   * debounced, so a burst of typing is one message rather than one per key.
   * Incoming edits are ignored while this user is actively typing — otherwise a
   * remote update would land mid-word and throw the caret to the end, which is
   * the thing that makes naive shared editors unusable.
   */
  let padSendTimer = null;
  let padLastTyped = 0;

  function padVisible() {
    return !el.padWrap.hidden;
  }

  function togglePad(show) {
    const next = show ?? el.padWrap.hidden;
    el.padWrap.hidden = !next;
    el.padBtn.classList.toggle('active', next);
    el.padBtn.setAttribute('aria-pressed', String(next));
    if (next) {
      socket.emit('pad:request');
      el.padText.focus();
    }
  }

  el.padBtn.addEventListener('click', () => togglePad());

  el.padText.addEventListener('input', () => {
    padLastTyped = Date.now();
    el.padNote.textContent = 'Syncing…';
    el.padNote.classList.add('saving');

    clearTimeout(padSendTimer);
    padSendTimer = setTimeout(() => {
      socket.emit('pad:update', { text: el.padText.value });
      el.padNote.textContent = 'Saved to the room';
      el.padNote.classList.remove('saving');
    }, 300);
  });

  socket.on('pad:sync', ({ text, by }) => {
    // Never overwrite someone mid-keystroke.
    if (Date.now() - padLastTyped < 1200) return;
    if (el.padText.value === text) return;

    const atEnd = el.padText.selectionStart === el.padText.value.length;
    const caret = el.padText.selectionStart;
    el.padText.value = text;
    // Keep the caret where it was unless it was trailing the text.
    el.padText.selectionStart = el.padText.selectionEnd = atEnd ? text.length : Math.min(caret, text.length);

    el.padNote.textContent = by ? `${by} is editing` : 'Updated';
    el.padNote.classList.remove('saving');

    // Opening the pad for the receiver is better than a silent change nobody
    // notices, but only once there is actually something to see.
    if (!padVisible() && text.trim()) {
      togglePad(true);
      toast('They opened a shared notepad');
    }
  });

  socket.on('pad:blocked', ({ reason }) => {
    el.padNote.textContent = 'Not shared — flagged content';
    el.padNote.classList.remove('saving');
    toast(`Notepad not shared: ${humanReason(reason)}`, 'err');
  });

  function resetPad() {
    clearTimeout(padSendTimer);
    el.padText.value = '';
    el.padNote.textContent = 'Both of you can type here';
    el.padNote.classList.remove('saving');
    togglePad(false);
  }

  // ------------------------------------------------------------- speech out

  /**
   * Reads text aloud on this device.
   *
   * Synthesis happens in the listener's browser rather than on the server, so
   * translated speech costs nothing per minute, transfers no audio, and adds
   * only a network hop. It also means it keeps working when the speech provider
   * is unreachable, which is the difference between a degraded feature and a
   * broken one.
   */
  const speech = {
    supported: 'speechSynthesis' in window,
    voices: [],

    load() {
      if (!this.supported) return;
      this.voices = speechSynthesis.getVoices();
      // Voices populate asynchronously in most browsers.
      speechSynthesis.addEventListener('voiceschanged', () => {
        this.voices = speechSynthesis.getVoices();
      });
    },

    /** Best voice for a language tag, falling back to the browser default. */
    voiceFor(lang) {
      if (!lang || !this.voices.length) return null;
      const exact = this.voices.find((v) => v.lang?.toLowerCase().startsWith(lang.toLowerCase()));
      return exact || null;
    },

    say(text, lang) {
      if (!this.supported || !text) return;
      // A backlog of queued speech is worse than silence — drop what is stale.
      if (speechSynthesis.speaking && speechSynthesis.pending) speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      const voice = this.voiceFor(lang);
      if (voice) utterance.voice = voice;
      if (lang) utterance.lang = voice?.lang || lang;
      utterance.rate = 1.02;
      speechSynthesis.speak(utterance);
    },

    stop() {
      if (this.supported) speechSynthesis.cancel();
    }
  };

  // Somebody typed, and this device reads it out.
  socket.on('spoken', ({ text, author, lang }) => {
    addMessage({ from: 'them', text: author ? `${author}: ${text}` : text });
    speech.say(text, state.translateTo || lang || state.language);
  });

  el.speakIncoming.addEventListener('change', () => {
    state.speakIncoming = el.speakIncoming.checked;
    store.write('speakIncoming', state.speakIncoming);
    if (!state.speakIncoming) speech.stop();
  });

  el.speakTyped.addEventListener('change', () => {
    state.speakTyped = el.speakTyped.checked;
    store.write('speakTyped', state.speakTyped);
  });

  // ------------------------------------------------------- calling someone

  let activeRing = null;

  function ringPerson({ token, clientId, name }) {
    if (state.phase !== 'idle') {
      toast('Hang up first, then call them', 'err');
      return;
    }
    socket.emit('call:ring', token ? { token } : { clientId });
    setStatus(`Calling <strong>${escapeHtml(name || 'them')}</strong>…`);
  }

  socket.on('call:ringing', ({ ringId, name }) => {
    activeRing = ringId;
    setStatus(`Ringing <strong>${escapeHtml(name)}</strong>…`);
    toast(`Calling ${name}`);
  });

  socket.on('call:incoming', async ({ ringId, name, country }) => {
    activeRing = ringId;
    el.ringName.textContent = `${name} is calling`;
    el.ringSub.textContent = country && country !== 'XX'
      ? `From ${countryLabel(country)}`
      : 'They want to talk to you.';
    el.ringAvatar.textContent = (name || '?').charAt(0);
    if (!el.ringModal.open) el.ringModal.showModal();

    if (window.Notification?.permission === 'granted' && document.hidden) {
      new Notification('Friends Talk', { body: `${name} is calling you` });
    }
  });

  socket.on('call:cancelled', () => {
    activeRing = null;
    if (el.ringModal.open) el.ringModal.close();
    toast('The caller hung up');
  });

  socket.on('call:failed', ({ reason, name }) => {
    activeRing = null;
    if (el.ringModal.open) el.ringModal.close();
    const messages = {
      unavailable: `${name || 'They'} is not available right now`,
      no_answer: `${name || 'They'} did not answer`,
      declined: 'They declined the call',
      expired: 'That contact has expired — you can only call back for a while',
      not_a_friend: 'You can only call people who accepted your friend request',
      blocked: 'You blocked this person',
      no_target: 'Nobody to call'
    };
    toast(messages[reason] || 'Could not connect the call', 'err');
    if (state.phase === 'idle') setStatus('Press call to meet someone new.');
  });

  el.ringAccept.addEventListener('click', async () => {
    if (!activeRing) return;
    try {
      await ensureMic();
      if (audioCtx?.state === 'suspended') await audioCtx.resume();
    } catch {
      toast('Microphone access is required to answer', 'err');
      return;
    }
    socket.emit('call:accept', { ringId: activeRing });
    el.ringModal.close();
    activeRing = null;
  });

  el.ringDecline.addEventListener('click', () => {
    if (activeRing) socket.emit('call:decline', { ringId: activeRing });
    el.ringModal.close();
    activeRing = null;
  });

  // ----------------------------------------------------------- group rooms

  /**
   * One entry per other person in the room: their own peer connection, their
   * audio element, and the analyser that drives the speaking indicator.
   *
   * They are kept separate on purpose. When somebody leaves, only their
   * connection is torn down — the rest of the room carries on untouched.
   */
  const groupPeers = new Map();

  async function startGroup() {
    try {
      await ensureMic();
      if (audioCtx?.state === 'suspended') await audioCtx.resume();
    } catch {
      toast('Microphone access is required for group rooms', 'err');
      setStatus('Microphone blocked. Allow it in your browser to join a room.');
      return;
    }

    state.phase = 'searching';
    paintPhase();
    setStatus('Finding a room…');
    socket.emit('group:join', { interests: state.interests });
  }

  function createGroupPeer(id, { name, country }) {
    if (groupPeers.has(id)) return groupPeers.get(id);

    const pc = new RTCPeerConnection({ iceServers: state.iceServers, iceCandidatePoolSize: 4 });
    const entry = { pc, name, country, audio: null, analyser: null, speaking: false, pending: [] };
    groupPeers.set(id, entry);

    if (localStream) {
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) socket.emit('group:signal', { to: id, data: { candidate: event.candidate } });
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      // Each remote stream needs its own element; one shared element would
      // simply replace whoever was playing.
      const audio = new Audio();
      audio.srcObject = stream;
      audio.autoplay = true;
      audio.play().catch(() => { /* a user gesture already happened on join */ });
      entry.audio = audio;
      entry.analyser = buildSpeakingAnalyser(stream);
      renderRoster();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') removeGroupPeer(id);
      renderRoster();
    };

    return entry;
  }

  function buildSpeakingAnalyser(stream) {
    try {
      const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      return analyser;
    } catch {
      return null;
    }
  }

  async function handleGroupSignal({ from, data }) {
    if (!data) return;
    let entry = groupPeers.get(from);

    // An offer can arrive from somebody we have not built a connection for yet.
    if (!entry) entry = createGroupPeer(from, { name: 'Someone', country: 'XX' });
    const { pc } = entry;

    if (data.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      for (const candidate of entry.pending) await pc.addIceCandidate(candidate).catch(() => {});
      entry.pending = [];

      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('group:signal', { to: from, data: { sdp: pc.localDescription } });
      }
      return;
    }

    if (data.candidate) {
      const candidate = new RTCIceCandidate(data.candidate);
      if (pc.remoteDescription?.type) await pc.addIceCandidate(candidate).catch(() => {});
      else entry.pending.push(candidate);
    }
  }

  function removeGroupPeer(id) {
    const entry = groupPeers.get(id);
    if (!entry) return;
    entry.pc.onicecandidate = null;
    entry.pc.ontrack = null;
    entry.pc.onconnectionstatechange = null;
    entry.pc.close();
    if (entry.audio) {
      entry.audio.pause();
      entry.audio.srcObject = null;
    }
    groupPeers.delete(id);
    renderRoster();
  }

  function stopGroup() {
    for (const id of [...groupPeers.keys()]) removeGroupPeer(id);
    removeFrameTask(speakingFrame);
    el.roster.hidden = true;
    state.groupRoom = null;
  }

  function renderRoster() {
    if (!state.groupRoom) return;
    const total = groupPeers.size + 1;
    el.roster.hidden = false;
    el.rosterHead.textContent = `In this room — ${total} of ${state.groupCapacity}`;
    el.rosterList.innerHTML = '';

    el.rosterList.appendChild(rosterRow({ name: state.selfName, country: null, you: true }));
    for (const [id, entry] of groupPeers) {
      el.rosterList.appendChild(rosterRow({
        id,
        name: entry.name,
        country: entry.country,
        connected: entry.pc.connectionState === 'connected',
        speaking: entry.speaking
      }));
    }
  }

  function rosterRow({ id, name, country, you, connected, speaking }) {
    const li = document.createElement('li');
    li.className = 'roster-item' + (speaking ? ' speaking' : '');
    if (id) li.dataset.peer = id;

    const avatar = document.createElement('div');
    avatar.className = 'roster-avatar';
    avatar.textContent = (name || '?').charAt(0);

    const body = document.createElement('div');
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = name || 'Someone';
    body.appendChild(nm);
    if (country) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = countryLabel(country);
      body.appendChild(sub);
    }

    const tail = document.createElement('span');
    tail.className = you ? 'you' : 'state';
    tail.textContent = you ? 'you' : (speaking ? 'speaking' : connected ? '' : 'connecting…');

    li.append(avatar, body, tail);
    return li;
  }

  /**
   * Drives the speaking indicator.
   *
   * A voice-only room gives no clue who is talking, which makes four people
   * genuinely hard to follow. Sampling each remote stream's level and lighting
   * up the matching row is the whole affordance.
   */
  const speakingData = new Uint8Array(256);
  let lastSpeakingCheck = 0;

  /**
   * Lights up whoever is talking.
   *
   * Sampled at roughly 12 Hz rather than every frame. Nobody can perceive a
   * speaking indicator updating faster than that, and at 60 Hz this would be
   * four extra FFT reads per frame in a five-person room, on the same thread
   * that has to keep the audio graph fed.
   */
  function speakingFrame() {
    const now = performance.now();
    if (now - lastSpeakingCheck < 80) return;
    lastSpeakingCheck = now;

    for (const [id, entry] of groupPeers) {
      if (!entry.analyser) continue;
      entry.analyser.getByteFrequencyData(speakingData);
      let sum = 0;
      for (let i = 0; i < speakingData.length; i++) sum += speakingData[i];
      const speaking = sum / speakingData.length > 8;
      if (speaking === entry.speaking) continue;

      entry.speaking = speaking;
      // Touch only the one row that changed, never the whole list.
      const row = el.rosterList.querySelector(`[data-peer="${id}"]`);
      if (row) {
        row.classList.toggle('speaking', speaking);
        const tail = row.querySelector('.state');
        if (tail) tail.textContent = speaking ? 'speaking' : '';
      }
    }
  }

  function runSpeakingDetection() {
    addFrameTask(speakingFrame);
  }

  socket.on('group:joined', async (payload) => {
    state.phase = 'matched';
    state.groupRoom = payload.roomId;
    state.groupCapacity = payload.capacity;
    state.mode = 'group';
    el.chatLog.innerHTML = '';
    el.queueNote.hidden = true;
    paintPhase();
    startTimer();
    renderRoster();
    runViz();
    runSpeakingDetection();

    setStatus(payload.members.length
      ? `You joined a room with ${payload.members.length} other ${payload.members.length === 1 ? 'person' : 'people'}`
      : 'Room opened — waiting for others to join');
    systemMessage(payload.members.length
      ? 'You joined the room.'
      : 'You opened a room. The next person looking for a group will land here.');

    // The arrival offers to everyone already present, so existing members only
    // ever answer and two peers can never offer each other simultaneously.
    for (const member of payload.members) {
      const entry = createGroupPeer(member.id, member);
      const offer = await entry.pc.createOffer({ offerToReceiveAudio: true });
      await entry.pc.setLocalDescription(offer);
      socket.emit('group:signal', { to: member.id, data: { sdp: entry.pc.localDescription } });
    }
  });

  socket.on('group:peer-joined', ({ peer, size }) => {
    // They will send us an offer; just record who they are for the roster.
    const existing = groupPeers.get(peer.id);
    if (existing) Object.assign(existing, { name: peer.name, country: peer.country });
    else groupPeers.set(peer.id, { pc: null, name: peer.name, country: peer.country, pending: [], speaking: false });
    systemMessage(`${peer.name} joined.`);
    setStatus(`${size} people in this room`);
    renderRoster();
  });

  socket.on('group:signal', async (payload) => {
    const entry = groupPeers.get(payload.from);
    // A placeholder from group:peer-joined has no connection yet.
    if (entry && !entry.pc) {
      const { name, country } = entry;
      groupPeers.delete(payload.from);
      createGroupPeer(payload.from, { name, country });
    }
    await handleGroupSignal(payload);
    runSpeakingDetection();
  });

  socket.on('group:peer-left', ({ id, size }) => {
    const entry = groupPeers.get(id);
    if (entry) systemMessage(`${entry.name} left.`);
    removeGroupPeer(id);
    setStatus(size > 1 ? `${size} people in this room` : 'Everyone else left — waiting for company');
  });

  socket.on('group:chat', (message) => {
    addMessage({
      from: message.from,
      text: message.from === 'me' ? message.text : `${message.author}: ${message.text}`
    });
  });

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
        duration: Date.now() - state.startedAt,
        // Lets this person be rung again without ever storing who they are.
        token: state.callbackToken || null
      });
    }
    state.callbackToken = null;
    exitFullscreenIfActive();
    stopSharing('teardown');
    watchingScreen = false;
    el.screenWrap.hidden = true;
    el.screenVideo.srcObject = null;
    closePeer();
    stopGroup();
    stopViz();
    stopCaptions();
    resetPad();
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
    const inGroup = Boolean(state.groupRoom);
    el.controls.hidden = !live;
    el.mute.hidden = !(state.mode === 'voice' || inGroup);
    el.voice.hidden = state.mode !== 'text' || inGroup;
    // Tic-tac-toe is a two-player game and "add friend" targets one partner;
    // neither has a meaning in a room of five, so both are hidden there.
    el.game.hidden = inGroup;
    el.friend.hidden = inGroup;
    el.next.hidden = inGroup;
    // Sharing into a mesh needs the track added to every peer connection
    // separately; until that is built, screen share is one-to-one only.
    // Hidden outright where the browser cannot capture a screen, rather than
    // offered and then failing when pressed.
    el.screenBtn.hidden = inGroup || state.mode === 'text' || !screenSupported();
    if (!live) closeMoreMenu();

    el.chatInput.disabled = !live;
    el.send.disabled = !live;
    el.image.disabled = !live;

    if (state.phase === 'idle') setStatus('Press call to meet someone new.');
  }

  el.callBtn.addEventListener('click', () => {
    if (state.phase === 'idle') {
      return el.mode.value === 'group' ? startGroup() : startSearch();
    }
    if (state.phase === 'searching') {
      socket.emit('cancel');
      state.phase = 'idle';
      paintPhase();
      return;
    }
    if (state.groupRoom) {
      socket.emit('group:leave');
      endCall('manual');
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

  // A long session otherwise grows the log without limit, and every new message
  // makes the browser lay out an ever-taller column. Old messages scroll out of
  // reach anyway, so the oldest are dropped once the log gets long.
  const MAX_CHAT_NODES = 150;

  function trimChatLog() {
    while (el.chatLog.childElementCount > MAX_CHAT_NODES) {
      el.chatLog.firstElementChild.remove();
    }
  }

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
    trimChatLog();
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  function sendChat() {
    const text = el.chatInput.value.trim();
    if (!text) return;

    if (state.speakTyped) {
      // Everyone else hears this read aloud on their own device, so somebody
      // who cannot speak can still take part in a voice conversation.
      socket.emit('speak', { text });
    } else {
      // Group chat fans out to the whole room; the typing indicator is
      // one-to-one only, since five people typing would just be noise.
      socket.emit(state.groupRoom ? 'group:chat' : 'chat', { text });
    }

    el.chatInput.value = '';
    if (!state.groupRoom) socket.emit('typing', { on: false });
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
    state.selfName = payload.name || 'You';
    paintStats(payload.stats);

    // Caption controls only exist if the server can actually transcribe.
    state.voiceFeatures = payload.voiceFeatures === true;
    el.captionSettings.hidden = !state.voiceFeatures;
    if (state.voiceFeatures) fillLanguages(payload.languages || {});
  });

  socket.on('hello:ok', (payload) => {
    // The server list is authoritative — it survives clearing this browser,
    // and it carries the client ids that make a friend callable.
    const friends = (payload?.friends || []).filter((f) => f?.clientId);
    if (friends.length) store.write('friendList', friends);
    renderFriends(friends.length ? friends : store.read('friendList', []));

    // Deliberately not surfaced to the user. Whether the server reached its
    // database is an operator concern: a visitor cannot act on it, and a line
    // about storage in the middle of a conversation is alarming noise. The
    // signal still exists where an operator will look — the boot log, and
    // `persistent` in /api/stats.
    if (payload && payload.persistent === false) {
      console.warn('[friends-talk] server is running without persistent storage');
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
    state.callbackToken = payload.callbackToken || null;

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

    // Reading the other person's words aloud is what turns captions into
    // translated speech: they speak their language, you hear yours.
    if (payload.from === 'them' && state.speakIncoming) {
      speech.say(payload.text, state.translateTo || state.language);
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

  socket.on('friend:added', ({ name, clientId }) => {
    const friends = store.read('friendList', []);
    if (!friends.some((f) => f.clientId === clientId)) friends.push({ name, clientId });
    store.write('friendList', friends);
    renderFriends(friends);
    toast(`${name} added to friends — you can call them back any time`, 'ok');
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

  // On phones the panes are bottom sheets. Only one may be open at a time —
  // two stacked sheets would bury the call entirely — and the scrim behind
  // them both dims the stage and gives a large, obvious way to dismiss.
  const scrim = $('sheet-scrim');
  const paneLeft = $('pane-left');
  const paneRight = $('pane-right');

  function closeSheets() {
    paneLeft.classList.remove('is-open');
    paneRight.classList.remove('is-open');
    scrim.classList.remove('is-open');
    // Kept out of the accessibility tree while invisible.
    scrim.hidden = true;
  }

  function toggleSheet(pane) {
    const opening = !pane.classList.contains('is-open');
    paneLeft.classList.remove('is-open');
    paneRight.classList.remove('is-open');

    if (opening) {
      pane.classList.add('is-open');
      scrim.hidden = false;
      // Next frame, so the transition has a start state to animate from.
      requestAnimationFrame(() => scrim.classList.add('is-open'));
    } else {
      closeSheets();
    }
  }

  $('toggle-left').addEventListener('click', () => toggleSheet(paneLeft));
  $('toggle-right').addEventListener('click', () => toggleSheet(paneRight));
  scrim.addEventListener('click', closeSheets);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSheets();
  });

  // Returning to a desktop width should not leave a half-open sheet behind.
  window.addEventListener('resize', () => {
    if (window.innerWidth > 760) closeSheets();
  });

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

    // Say plainly why the share control is absent, so its absence does not read
    // as the app being broken on this device.
    if (!screenSupported()) {
      el.screenSupportHint.hidden = false;
      el.screenSupportHint.textContent = isMobileBrowser()
        ? 'Phones and tablets cannot share a screen — no mobile browser allows it. You can still watch a screen someone else shares.'
        : 'This browser cannot share a screen. You can still watch one that is shared with you.';
    }

    speech.load();
    state.speakIncoming = store.read('speakIncoming', false);
    state.speakTyped = store.read('speakTyped', false);
    el.speakIncoming.checked = state.speakIncoming;
    el.speakTyped.checked = state.speakTyped;
    if (!speech.supported) {
      el.speakIncoming.disabled = true;
      el.speakTyped.disabled = true;
      el.speechHint.textContent = 'This browser cannot synthesise speech.';
    }

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
    renderFriends(store.read('friendList', []));
    paintPhase();
    bootAgeGate();
  }

  boot();
})();

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
    callbackToken: null,
    pushKey: null
  };

  let pc = null;
  // Id of the stream carrying the partner's voice, fixed for the life of a
  // call so a later screen-audio stream can never be mistaken for it.
  let voiceStreamId = null;
  let localStream = null;
  let processedStream = null;
  let processedStreamDestination = null;
  let rawSource = null;
  let currentFilter = 'none';
  let effectsOutput = null;
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
    installBtn: $('install-btn'),
    speakIncoming: $('speak-incoming'), speakTyped: $('speak-typed'),
    speechHint: $('speech-hint'),
    ringModal: $('ring-modal'), ringName: $('ring-name'), ringSub: $('ring-sub'),
    ringAvatar: $('ring-avatar'), ringAccept: $('ring-accept'), ringDecline: $('ring-decline'),
    padBtn: $('btn-pad'), padWrap: $('pad-wrap'), padText: $('pad-text'), padNote: $('pad-note'),
    screenBtn: $('btn-screen'), screenWrap: $('screen-wrap'), screenVideo: $('screen-video'),
    screenLabel: $('screen-label'), screenStop: $('screen-stop'), screenReport: $('screen-report'),
    screenFull: $('screen-full'), screenFullLabel: $('screen-full-label'),
    screenSound: $('screen-sound'),
    screenMaximize: $('screen-maximize'),
    screenModal: $('screen-modal'), screenAskTitle: $('screen-ask-title'),
    screenAskBody: $('screen-ask-body'), screenAskAccept: $('screen-ask-accept'),
    screenAskDecline: $('screen-ask-decline'),
    
    // Modulator / Soundboard / Icebreaker
    modifierBtn: $('btn-modifier'), modifierMenu: $('modifier-menu'),
    soundboardBtn: $('btn-soundboard'), soundboardMenu: $('soundboard-menu'),
    icebreakerWrap: $('icebreaker-wrap'), icebreakerText: $('icebreaker-text'), icebreakerNext: $('icebreaker-next'),
    
    // Pitch Match Game UI
    gameSelectPane: $('game-select-pane'), gameSelectTTT: $('game-select-ttt'), gameSelectPM: $('game-select-pm'),
    gameSelectTrivia: $('game-select-trivia'), gameSelectDraw: $('game-select-draw'),
    gameTTTPane: $('game-ttt-pane'), gamePMPane: $('game-pm-pane'),
    gameTriviaPane: $('game-trivia-pane'), gameDrawPane: $('game-draw-pane'),
    pitchTargetHz: $('pitch-target-hz'), pitchTargetZone: $('pitch-target-zone'),
    pitchNeedle: $('pitch-needle'), pitchCurrentVal: $('pitch-current-val'),
    pitchLockBtn: $('pitch-lock-btn'), pitchPMStatus: $('game-pm-status'),

    // Trivia Battle UI
    gameEndBar: $('game-end-bar'), gameEndNote: $('game-end-note'),
    gameAgain: $('game-again'), gamePick: $('game-pick'),
    triviaQNum: $('trivia-q-num'), triviaTimer: $('trivia-timer'),
    triviaScoreMe: $('trivia-score-me'), triviaScoreThem: $('trivia-score-them'),
    triviaQuestion: $('trivia-question'), triviaOptions: $('trivia-options'), triviaStatus: $('trivia-status'),

    // Drawing Board UI
    drawWordBadge: $('draw-word-badge'), drawTools: $('draw-tools'), drawClearBtn: $('draw-clear-btn'),
    drawCanvas: $('draw-canvas'), drawStatus: $('draw-status'),

    // Watch Party & Soundscape UI
    watchBtn: $('btn-watch'), watchWrap: $('watch-wrap'), watchClose: $('watch-close'),
    watchUrlInput: $('watch-url-input'), watchLoadBtn: $('watch-load-btn'), watchPlayer: $('watch-player'),
    soundscapeBtn: $('btn-soundscape'), soundscapeMenu: $('soundscape-menu'), soundscapeVolume: $('soundscape-volume'),

    // Lounges UI & Custom Creator
    loungesList: $('lounges-list'),
    btnCreateLounge: $('btn-create-lounge'),
    createLoungeModal: $('create-lounge-modal'),
    loungeNameInput: $('lounge-name-input'),
    loungeDescInput: $('lounge-desc-input'),
    loungeIconInput: $('lounge-icon-input'),
    loungeCancelBtn: $('lounge-cancel-btn'),
    loungeSubmitBtn: $('lounge-submit-btn'),

    // Reaction Sparks & AI Matrix
    reactionDock: $('reaction-dock'),
    particlesHost: $('particles-host'),
    sparkCategories: $('spark-categories'),
    debateTimerWrap: $('debate-timer-wrap'),
    debateTimerClock: $('debate-timer-clock'),
    debateTimerBtn: $('debate-timer-btn'),

    // Reflex Clash Game
    gameSelectReflex: $('game-select-reflex'),
    gameReflexPane: $('game-reflex-pane'),
    reflexRoundBadge: $('reflex-round-badge'),
    reflexScoreMe: $('reflex-score-me'),
    reflexScoreThem: $('reflex-score-them'),
    reflexStatus: $('reflex-status'),
    reflexBuzzerBtn: $('reflex-buzzer-btn'),
    reflexBuzzerText: $('reflex-buzzer-text'),
    reflexLatency: $('reflex-latency')
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

  // The big button says what it will do in the chosen mode, not just "Call".
  const IDLE_CAPTIONS = { voice: 'Call', text: 'Chat', group: 'Join' };
  const stageModes = $('stage-modes');

  function setMode(next) {
    // The sidebar control and the welcome chips are two views of one setting.
    for (const seg of document.querySelectorAll('#mode-seg .seg, #stage-modes .mode-chip')) {
      const on = seg.dataset.mode === next;
      seg.classList.toggle('is-active', on);
      seg.setAttribute('aria-checked', String(on));
    }
    state.mode = next;
    store.write('mode', next);
    if (el.modeHint) el.modeHint.textContent = MODE_HINTS[next] || '';
    if (state.phase === 'idle') paintIdle();
  }

  function paintIdle() {
    el.callCap.textContent = IDLE_CAPTIONS[state.mode] || 'Call';
    el.callBtn.setAttribute('aria-label', state.mode === 'group'
      ? 'Join a group room' : state.mode === 'text' ? 'Start a text chat' : 'Call a stranger');
    setStatus(MODE_HINTS[state.mode] || 'Press call to meet someone new.');
  }

  stageModes.addEventListener('click', (event) => {
    const chip = event.target.closest('.mode-chip');
    if (chip) setMode(chip.dataset.mode);
  });

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
      el.notify.checked = false;
      store.write('notify', false);
      socket.emit('notify', { on: false });
      return;
    }

    store.write('notify', on);
    socket.emit('notify', { on });

    // Push is what reaches someone once the tab is gone; the in-page toast
    // only works while they are still here.
    if (on && Notification.permission === 'granted') {
      const subscribed = await subscribeToPush();
      toast(subscribed
        ? 'You will be notified even when this tab is closed'
        : 'Notifications on while this tab is open');
    } else if (!on) {
      await unsubscribeFromPush();
    }
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
    rawSource = audioCtx.createMediaStreamSource(stream);

    processedStreamDestination = audioCtx.createMediaStreamDestination();
    effectsOutput = audioCtx.createGain();

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;

    effectsOutput.connect(analyser);
    effectsOutput.connect(processedStreamDestination);
    processedStream = processedStreamDestination.stream;

    applyVoiceFilter(currentFilter);
    estimateGender();
  }

  let activeModifierNodes = [];

  function applyVoiceFilter(filterName) {
    currentFilter = filterName || 'none';
    if (!audioCtx || !rawSource || !effectsOutput) return;

    activeModifierNodes.forEach((node) => {
      try { node.disconnect(); } catch (e) {}
      if (node.stop) { try { node.stop(); } catch (e) {} }
    });
    activeModifierNodes = [];
    rawSource.disconnect();

    if (currentFilter === 'robot') {
      const filter = audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1000;
      filter.Q.value = 1;

      const ringMod = audioCtx.createGain();
      ringMod.gain.value = 0.5;

      const lfo = audioCtx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 50;

      const lfoGain = audioCtx.createGain();
      lfoGain.gain.value = 0.5;

      lfo.connect(lfoGain);
      lfoGain.connect(ringMod.gain);

      rawSource.connect(filter);
      filter.connect(ringMod);
      ringMod.connect(effectsOutput);

      lfo.start();
      activeModifierNodes.push(filter, ringMod, lfo, lfoGain);

    } else if (currentFilter === 'deep') {
      const lowpass = audioCtx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 380;

      const peak = audioCtx.createBiquadFilter();
      peak.type = 'peaking';
      peak.frequency.value = 110;
      peak.gain.value = 15;
      peak.Q.value = 2;

      rawSource.connect(peak);
      peak.connect(lowpass);
      lowpass.connect(effectsOutput);

      activeModifierNodes.push(peak, lowpass);

    } else if (currentFilter === 'chipmunk') {
      const highpass = audioCtx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 1200;

      const peak = audioCtx.createBiquadFilter();
      peak.type = 'peaking';
      peak.frequency.value = 2500;
      peak.gain.value = 12;
      peak.Q.value = 1.5;

      rawSource.connect(highpass);
      highpass.connect(peak);
      peak.connect(effectsOutput);

      activeModifierNodes.push(highpass, peak);

    } else if (currentFilter === 'alien') {
      const ringMod = audioCtx.createGain();
      ringMod.gain.value = 0.5;

      const lfo = audioCtx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 180;

      const lfoGain = audioCtx.createGain();
      lfoGain.gain.value = 0.5;

      lfo.connect(lfoGain);
      lfoGain.connect(ringMod.gain);

      const delay = audioCtx.createDelay();
      delay.delayTime.value = 0.15;

      const feedback = audioCtx.createGain();
      feedback.gain.value = 0.45;

      rawSource.connect(ringMod);
      ringMod.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);

      ringMod.connect(effectsOutput);
      delay.connect(effectsOutput);

      lfo.start();
      activeModifierNodes.push(ringMod, lfo, lfoGain, delay, feedback);

    } else if (currentFilter === 'spatial-orbit') {
      // 3D Spatial Audio Orbit: Binaural stereo panner with LFO
      if (audioCtx.createStereoPanner) {
        const panner = audioCtx.createStereoPanner();
        const lfo = audioCtx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 0.35; // One orbit every ~3 seconds

        lfo.connect(panner.pan);
        rawSource.connect(panner);
        panner.connect(effectsOutput);
        lfo.start();
        activeModifierNodes.push(panner, lfo);
      } else {
        rawSource.connect(effectsOutput);
      }

    } else if (currentFilter === 'radio') {
      // Walkie-Talkie Radio: Bandpass filter + slight overdrive
      const hp = audioCtx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 500;

      const lp = audioCtx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2800;

      const shaper = audioCtx.createWaveShaper();
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        const x = (i * 2) / 256 - 1;
        curve[i] = ((Math.PI + 3) * x) / (Math.PI + 3 * Math.abs(x));
      }
      shaper.curve = curve;

      rawSource.connect(hp);
      hp.connect(lp);
      lp.connect(shaper);
      shaper.connect(effectsOutput);
      activeModifierNodes.push(hp, lp, shaper);

    } else if (currentFilter === 'reverb') {
      // Cyber Stadium Reverb: Multi-tap delay network
      const dryGain = audioCtx.createGain();
      const wetGain = audioCtx.createGain();
      dryGain.gain.value = 0.7;
      wetGain.gain.value = 0.5;

      const delay1 = audioCtx.createDelay();
      delay1.delayTime.value = 0.08;
      const delay2 = audioCtx.createDelay();
      delay2.delayTime.value = 0.16;
      const feedback = audioCtx.createGain();
      feedback.gain.value = 0.4;

      rawSource.connect(dryGain);
      dryGain.connect(effectsOutput);

      rawSource.connect(delay1);
      delay1.connect(delay2);
      delay2.connect(feedback);
      feedback.connect(delay1);
      delay2.connect(wetGain);
      wetGain.connect(effectsOutput);

      activeModifierNodes.push(dryGain, wetGain, delay1, delay2, feedback);

    } else if (currentFilter === 'vinyl') {
      // Vintage Lo-Fi Vinyl: Warm lowpass + subtle pitch flutter
      const lp = audioCtx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2200;

      const delay = audioCtx.createDelay();
      delay.delayTime.value = 0.02;

      const lfo = audioCtx.createOscillator();
      lfo.frequency.value = 1.2;
      const lfoGain = audioCtx.createGain();
      lfoGain.gain.value = 0.0008;

      lfo.connect(lfoGain);
      lfoGain.connect(delay.delayTime);

      rawSource.connect(lp);
      lp.connect(delay);
      delay.connect(effectsOutput);
      lfo.start();

      activeModifierNodes.push(lp, delay, lfo, lfoGain);

    } else {
      rawSource.connect(effectsOutput);
    }
  }

  function triggerSynthesizedSound(name) {
    if (!audioCtx || !effectsOutput) return;
    
    const destination = effectsOutput;
    const now = audioCtx.currentTime;

    if (name === 'airhorn') {
      const osc1 = audioCtx.createOscillator();
      const osc2 = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      osc1.type = 'sawtooth';
      osc2.type = 'square';

      osc1.frequency.setValueAtTime(280, now);
      osc2.frequency.setValueAtTime(285, now);

      osc1.frequency.exponentialRampToValueAtTime(140, now + 1.2);
      osc2.frequency.exponentialRampToValueAtTime(142, now + 1.2);

      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.35, now + 0.05);
      gainNode.gain.setValueAtTime(0.35, now + 0.8);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 1.2);

      osc1.connect(gainNode);
      osc2.connect(gainNode);
      gainNode.connect(destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 1.2);
      osc2.stop(now + 1.2);

    } else if (name === 'drumroll') {
      const bufferSize = audioCtx.sampleRate * 1.5;
      const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const noise = audioCtx.createBufferSource();
      noise.buffer = buffer;

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(180, now);

      const vca = audioCtx.createGain();
      vca.gain.setValueAtTime(0, now);
      
      const duration = 1.5;
      const steps = 30;
      for (let i = 0; i < steps; i++) {
        const time = now + (i / steps) * duration;
        const vol = 0.15 + Math.random() * 0.15;
        vca.gain.setValueAtTime(vol, time);
        vca.gain.setValueAtTime(0.01, time + 0.03);
      }

      const crashOsc = audioCtx.createOscillator();
      const crashGain = audioCtx.createGain();
      crashOsc.type = 'sawtooth';
      crashOsc.frequency.setValueAtTime(12000, now + duration);
      crashGain.gain.setValueAtTime(0, now + duration);
      crashGain.gain.linearRampToValueAtTime(0.4, now + duration + 0.02);
      crashGain.gain.exponentialRampToValueAtTime(0.001, now + duration + 0.8);

      noise.connect(filter);
      filter.connect(vca);
      vca.connect(destination);

      crashOsc.connect(crashGain);
      crashGain.connect(destination);

      noise.start(now);
      noise.stop(now + duration);
      crashOsc.start(now + duration);
      crashOsc.stop(now + duration + 0.8);

    } else if (name === 'applause') {
      const duration = 2.0;
      const bufferSize = audioCtx.sampleRate * duration;
      const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const noise = audioCtx.createBufferSource();
      noise.buffer = buffer;

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1500, now);
      filter.Q.setValueAtTime(1.0, now);

      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.2, now + 0.1);

      for (let i = 0; i < 40; i++) {
        const t = now + Math.random() * (duration - 0.5);
        gain.gain.setValueAtTime(0.25, t);
        gain.gain.exponentialRampToValueAtTime(0.02, t + 0.06);
      }
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(destination);

      noise.start(now);
      noise.stop(now + duration);

    } else if (name === 'rimshot') {
      const stick = audioCtx.createOscillator();
      const stickGain = audioCtx.createGain();
      stick.type = 'sine';
      stick.frequency.setValueAtTime(450, now);
      stick.frequency.exponentialRampToValueAtTime(150, now + 0.05);

      stickGain.gain.setValueAtTime(0.4, now);
      stickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

      const bufferSize = audioCtx.sampleRate * 0.12;
      const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

      const noise = audioCtx.createBufferSource();
      noise.buffer = buffer;

      const noiseFilter = audioCtx.createBiquadFilter();
      noiseFilter.type = 'highpass';
      noiseFilter.frequency.setValueAtTime(1000, now);

      const noiseGain = audioCtx.createGain();
      noiseGain.gain.setValueAtTime(0.35, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

      stick.connect(stickGain);
      stickGain.connect(destination);

      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(destination);

      stick.start(now);
      stick.stop(now + 0.05);
      noise.start(now);
      noise.stop(now + 0.12);

    } else if (name === 'scratch') {
      const duration = 0.5;
      const bufferSize = audioCtx.sampleRate * duration;
      const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

      const noise = audioCtx.createBufferSource();
      noise.buffer = buffer;

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 3.0;

      filter.frequency.setValueAtTime(2000, now);
      filter.frequency.linearRampToValueAtTime(300, now + 0.15);
      filter.frequency.linearRampToValueAtTime(2500, now + 0.35);
      filter.frequency.exponentialRampToValueAtTime(1000, now + 0.5);

      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.25, now + 0.05);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.2);
      gain.gain.linearRampToValueAtTime(0.28, now + 0.35);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(destination);

      noise.start(now);
      noise.stop(now + duration);
    }
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

  // ------------------------------------------------------- installability

  /**
   * Registers the service worker and handles the install prompt.
   *
   * Registration is deferred until after load so it never competes with the
   * work of actually getting a call connected, which is what someone opening
   * this page came for.
   */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // A service worker needs a secure context; localhost counts as one.
    if (!window.isSecureContext) return;

    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((error) => {
        console.warn('[friends-talk] service worker registration failed:', error.message);
      });
    });
  }

  /**
   * Chrome and friends fire beforeinstallprompt and expect the page to hold on
   * to it and present its own button. iOS fires nothing at all — there, adding
   * to the home screen is a manual Share-sheet action, so the hint says so
   * rather than showing a button that cannot work.
   */
  let installPrompt = null;

  function setupInstall() {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      installPrompt = event;
      el.installBtn.hidden = false;
    });

    el.installBtn.addEventListener('click', async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      installPrompt = null;
      el.installBtn.hidden = true;
      if (outcome === 'accepted') toast('Installed — look for the icon on your home screen', 'ok');
    });

    window.addEventListener('appinstalled', () => {
      installPrompt = null;
      el.installBtn.hidden = true;
    });

    // Already running as an installed app: nothing to offer.
    const standalone = window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
    if (standalone) el.installBtn.hidden = true;
  }

  // ------------------------------------------------------------- shortcuts

  /**
   * Keyboard shortcuts for the controls used most during a call.
   *
   * Deliberately ignored while typing: a chat box that swallows the letter M
   * because it means "mute" is worse than having no shortcuts at all. Space is
   * also let through for anything the browser already treats as a button.
   */
  function isTyping(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  const SHORTCUTS = {
    ' ': () => el.callBtn.click(),          // call / hang up
    n: () => { if (!el.next.hidden && state.phase !== 'idle') el.next.click(); },
    m: () => { if (!el.mute.hidden && state.phase !== 'idle') el.mute.click(); },
    t: () => { if (state.phase !== 'idle') { el.chatInput.focus(); } },
    p: () => { if (state.phase !== 'idle') el.padBtn.click(); }
  };

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTyping(event.target)) return;
    // A dialog is modal; its own buttons and Escape should win.
    if (document.querySelector('dialog[open]')) return;

    const action = SHORTCUTS[event.key.toLowerCase()];
    if (!action) return;
    event.preventDefault();
    action();
  });

  // ---------------------------------------------------- push notifications

  /**
   * Subscribes this browser to push, so a ring or a busy queue can reach
   * someone whose tab is closed.
   *
   * The permission prompt is deliberately not fired on page load. A site that
   * asks the moment it opens gets denied, and a denial is sticky — the browser
   * will not ask again. So this only runs when the user turns the notify
   * switch on, which is them asking for it.
   */
  function urlBase64ToUint8Array(base64) {
    const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const raw = atob(padded);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function subscribeToPush() {
    if (!state.pushKey) return false;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;

    try {
      const registration = await navigator.serviceWorker.ready;

      // Reuse an existing subscription rather than creating a second one.
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,   // required by Chrome, and honest anyway
          applicationServerKey: urlBase64ToUint8Array(state.pushKey)
        });
      }

      socket.emit('push:subscribe', { subscription: subscription.toJSON() });
      return true;
    } catch (error) {
      console.warn('[friends-talk] push subscribe failed:', error.message);
      return false;
    }
  }

  async function unsubscribeFromPush() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) return;
      socket.emit('push:unsubscribe', { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    } catch { /* nothing useful to do if teardown fails */ }
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

  // ------------------------------------------------------------- AI Sparks Matrix
  let activeIcebreakers = [];
  let currentIcebreakerIndex = 0;
  let currentSparkCategory = 'all';
  let currentPitchHz = 0;
  let pitchTrackInterval = null;
  let debateTimerInterval = null;
  let debateSecondsLeft = 60;

  const SPARKS_CATALOG = {
    all: [
      "If you could have dinner with any historical figure, who would it be?",
      "What is a popular trend or opinion that you completely disagree with?",
      "Would you rather live 100 years into the past or 100 years into the future?",
      "What's something you could give a 30-minute spontaneous talk on with zero prep?",
      "If teleportation was invented tomorrow, where would you go first?",
      "What's your most memorable travel story or unexpected adventure?",
      "What's a skill you picked up during lockdown that you still use today?",
      "If you could master any musical instrument overnight, which one?",
      "What's the best piece of advice you've ever been given?",
      "If you had to eat one cuisine for the rest of your life, which would it be?",
      "What's a movie you can rewatch endlessly without getting bored?",
      "If you could witness any event in history firsthand, what would it be?"
    ],
    deep: [
      "What truth do you believe that very few people agree with you on?",
      "What is the most defining lesson life has taught you in the last two years?",
      "If you knew you only had one year left, what would you immediately change?",
      "Do you think AI will ultimately unite humanity or divide it further?",
      "What gives you a genuine sense of peace when the world feels chaotic?",
      "What's something you used to be certain about but completely changed your mind on?",
      "Do you think free will is real, or are we just following a script we can't see?",
      "If you could solve one global problem overnight, which would you choose and why?",
      "What does 'living a meaningful life' actually mean to you?",
      "Do you think humans are fundamentally cooperative or competitive by nature?"
    ],
    wyr: [
      "⚡ Would You Rather: Have the ability to fly or become completely invisible?",
      "⚡ Would You Rather: Explore the deepest unexplored ocean or colonize Mars?",
      "⚡ Would You Rather: Always say everything on your mind or never speak again?",
      "⚡ Would You Rather: Have unlimited money but no free time, or unlimited free time on a tight budget?",
      "⚡ Would You Rather: Win an Olympic Gold medal or an Academy Award?",
      "⚡ Would You Rather: Know every language fluently or play every instrument perfectly?",
      "⚡ Would You Rather: Live in a world with no internet or no air conditioning?",
      "⚡ Would You Rather: Be able to talk to animals or speak every human language?",
      "⚡ Would You Rather: Always be 10 minutes late or always be 20 minutes early?",
      "⚡ Would You Rather: Have a rewind button for your life or a pause button?"
    ],
    debate: [
      "🔥 60s Debate: Pineapples on pizza is an abomination vs a culinary masterpiece.",
      "🔥 60s Debate: Remote work is strictly better than in-office culture.",
      "🔥 60s Debate: Books are always inherently superior to their movie adaptations.",
      "🔥 60s Debate: Social media has done more harm than good for society.",
      "🔥 60s Debate: Video games are an art form equal to classical cinema and literature.",
      "🔥 60s Debate: Everyone should learn to code, even non-tech professionals.",
      "🔥 60s Debate: Cryptocurrency will eventually replace traditional banking.",
      "🔥 60s Debate: AI-generated art should be considered real art.",
      "🔥 60s Debate: Universities are becoming less relevant in the age of the internet.",
      "🔥 60s Debate: Morning people are more productive than night owls."
    ],
    takes: [
      "🎭 Hot Take: Cereal is technically a cold soup.",
      "🎭 Hot Take: Most movies would be 100x better if they were 90 minutes or less.",
      "🎭 Hot Take: Mondays aren't bad; your routine is bad.",
      "🎭 Hot Take: Voice notes are vastly superior to long text paragraphs.",
      "🎭 Hot Take: Nostalgia makes older music and games seem much better than they actually were.",
      "🎭 Hot Take: Dark mode is objectively superior to light mode.",
      "🎭 Hot Take: Dogs are overrated and cats are underrated.",
      "🎭 Hot Take: The best travel experiences are solo trips, not group vacations.",
      "🎭 Hot Take: Breakfast for dinner is better than actual dinner.",
      "🎭 Hot Take: Audiobooks count as reading. Full stop."
    ]
  };

  async function loadIcebreakers(interests) {
    el.icebreakerWrap.hidden = false;
    el.icebreakerText.textContent = "Generating conversation sparks…";
    currentIcebreakerIndex = 0;
    activeIcebreakers = [];

    // Try the AI-powered endpoint first — it generates interest-tailored prompts
    try {
      const query = interests && interests.length ? `?interests=${encodeURIComponent(interests.join(','))}` : '';
      const res = await fetch(`/api/icebreaker${query}`);
      const data = await res.json();
      if (data.ok && data.icebreakers) {
        activeIcebreakers = data.icebreakers
          .split('\n')
          .map((line) => line.replace(/^\d+\.\s*/, '').trim())
          .filter(Boolean);
      }
    } catch (e) {
      console.warn("Icebreaker API unavailable, using local spark catalog", e.message);
    }

    // Fall back to the local curated catalog if the API returned nothing
    if (!activeIcebreakers.length) {
      activeIcebreakers = [...(SPARKS_CATALOG[currentSparkCategory] || SPARKS_CATALOG.all)]
        .sort(() => 0.5 - Math.random());
    }
    showCurrentIcebreaker();
  }

  function showCurrentIcebreaker(isRemote = false) {
    if (!activeIcebreakers.length) {
      activeIcebreakers = [...(SPARKS_CATALOG[currentSparkCategory] || SPARKS_CATALOG.all)];
    }
    const prompt = activeIcebreakers[currentIcebreakerIndex % activeIcebreakers.length];
    el.icebreakerText.textContent = prompt;

    const isDebate = currentSparkCategory === 'debate' || prompt.includes('Debate:');
    el.debateTimerWrap.hidden = !isDebate;

    if (!isRemote) {
      socket.emit('spark:sync', {
        category: currentSparkCategory,
        promptIndex: currentIcebreakerIndex,
        prompt
      });
    }
  }

  // AI Sparks category chips
  for (const catBtn of document.querySelectorAll('.spark-cat')) {
    catBtn.addEventListener('click', () => {
      for (const b of document.querySelectorAll('.spark-cat')) b.classList.remove('is-active');
      catBtn.classList.add('is-active');
      currentSparkCategory = catBtn.dataset.cat || 'all';
      activeIcebreakers = [...(SPARKS_CATALOG[currentSparkCategory] || SPARKS_CATALOG.all)].sort(() => 0.5 - Math.random());
      currentIcebreakerIndex = 0;
      showCurrentIcebreaker();
    });
  }

  // 60-Second Debate Timer
  el.debateTimerBtn?.addEventListener('click', () => {
    startDebateCountdown();
    socket.emit('spark:sync', { action: 'start_timer' });
  });

  function startDebateCountdown() {
    clearInterval(debateTimerInterval);
    debateSecondsLeft = 60;
    el.debateTimerClock.textContent = `⏱️ ${debateSecondsLeft}s`;
    el.debateTimerBtn.disabled = true;

    debateTimerInterval = setInterval(() => {
      debateSecondsLeft--;
      el.debateTimerClock.textContent = `⏱️ ${debateSecondsLeft}s`;
      if (debateSecondsLeft <= 0) {
        clearInterval(debateTimerInterval);
        el.debateTimerClock.textContent = `🔔 Time's Up!`;
        el.debateTimerBtn.disabled = false;
        triggerSynthesizedSound('rimshot');
        toast('🔔 60s Debate round finished!');
      }
    }, 1000);
  }

  socket.on('spark:sync', (payload) => {
    if (payload.action === 'start_timer') {
      startDebateCountdown();
      toast('⏱️ Partner started the 60s debate timer!');
      return;
    }
    if (payload.category) {
      currentSparkCategory = payload.category;
      for (const b of document.querySelectorAll('.spark-cat')) {
        b.classList.toggle('is-active', b.dataset.cat === payload.category);
      }
    }
    if (payload.prompt) {
      el.icebreakerWrap.hidden = false;
      el.icebreakerText.textContent = payload.prompt;
      const isDebate = payload.prompt.includes('Debate:');
      el.debateTimerWrap.hidden = !isDebate;
    }
  });

  // ------------------------------------------------------------- Real-time Reaction Particles
  function triggerReactionBurst(emoji = '🔥', isRemote = false) {
    if (!el.particlesHost) return;

    // Trigger subtle synthesizer audio blip
    if (audioCtx) {
      try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(isRemote ? 520 : 680, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(isRemote ? 780 : 960, audioCtx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.15);
      } catch (e) {}
    }

    const count = 14;
    const startX = isRemote ? window.innerWidth * 0.35 : window.innerWidth * 0.65;
    const startY = window.innerHeight * 0.65;

    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'reaction-particle';
      p.textContent = emoji;
      p.style.left = startX + (Math.random() * 60 - 30) + 'px';
      p.style.top = startY + (Math.random() * 40 - 20) + 'px';
      p.style.fontSize = (24 + Math.random() * 18) + 'px';

      const dx = (Math.random() * 260 - 130) + 'px';
      const dyMid = (-80 - Math.random() * 120) + 'px';
      const dyEnd = (-200 - Math.random() * 250) + 'px';
      const rotMid = (Math.random() * 60 - 30) + 'deg';
      const rotEnd = (Math.random() * 180 - 90) + 'deg';

      p.style.setProperty('--dx', dx);
      p.style.setProperty('--dy-mid', dyMid);
      p.style.setProperty('--dy-end', dyEnd);
      p.style.setProperty('--rot-mid', rotMid);
      p.style.setProperty('--rot-end', rotEnd);
      p.style.animationDelay = (Math.random() * 0.15) + 's';

      el.particlesHost.appendChild(p);
      setTimeout(() => p.remove(), 2000);
    }
  }

  for (const rBtn of document.querySelectorAll('.react-btn')) {
    rBtn.addEventListener('click', () => {
      const emoji = rBtn.dataset.emoji || '🔥';
      triggerReactionBurst(emoji, false);
      socket.emit('reaction', { emoji });
    });
  }

  socket.on('reaction', ({ emoji, from }) => {
    triggerReactionBurst(emoji || '🔥', true);
  });

  function startPitchMatchTracking() {
    if (pitchTrackInterval) clearInterval(pitchTrackInterval);
    const buf = new Float32Array(analyser ? analyser.fftSize : 2048);

    pitchTrackInterval = setInterval(() => {
      if (!analyser || state.phase !== 'live') return;
      
      analyser.getFloatTimeDomainData(buf);
      const f0 = detectPitch(buf, audioCtx.sampleRate);
      
      if (f0 > 80 && f0 < 350) {
        currentPitchHz = f0;
        el.pitchCurrentVal.textContent = Math.round(f0) + " Hz";
        
        const pct = Math.max(0, Math.min(100, ((f0 - 90) / (310 - 90)) * 100));
        el.pitchNeedle.style.left = pct + "%";
      }
    }, 100);
  }

  function stopPitchMatchTracking() {
    if (pitchTrackInterval) {
      clearInterval(pitchTrackInterval);
      pitchTrackInterval = null;
    }
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
      const streamToSend = processedStream || localStream;
      for (const track of streamToSend.getTracks()) pc.addTrack(track, streamToSend);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) socket.emit('signal', { data: { candidate: event.candidate } });
    };

    pc.ontrack = (event) => {
      // The same connection can carry three things — the partner's voice, a
      // shared screen, and that screen's sound — so nothing here may assume
      // an incoming track is the voice.
      if (event.track.kind === 'video') {
        showRemoteScreen(new MediaStream([event.track]));
        event.track.addEventListener('ended', hideRemoteScreen);
        return;
      }

      /*
       * Audio: the first stream to arrive is the voice, and it stays the voice.
       * A screen's sound arrives later on a different stream. Without this
       * check it would be routed to the voice player and replace the partner
       * — they would go silent the moment they shared a video with sound.
       */
      const stream = event.streams[0];
      if (!voiceStreamId || stream?.id === voiceStreamId) {
        voiceStreamId = stream?.id || voiceStreamId;
        el.remote.srcObject = stream;
        el.remote.play().catch(() => { /* autoplay policy — user gesture already happened */ });
        return;
      }

      playScreenAudio(new MediaStream([event.track]));
      event.track.addEventListener('ended', stopScreenAudio);
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
    voiceStreamId = null;
    el.remote.srcObject = null;
    stopScreenAudio();
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
  let screenSenders = [];   // video, and audio when the share includes sound

  /*
   * The shared screen's sound plays through its own element, separate from
   * the partner's voice, so either can be stopped or muted without touching
   * the other.
   */
  const screenAudio = new Audio();
  screenAudio.autoplay = true;

  function playScreenAudio(stream) {
    screenAudio.srcObject = stream;
    screenAudio.muted = false;
    screenAudio.play().catch(() => { /* a click already happened during the call */ });
    el.screenSound.hidden = false;
    paintScreenSound();
  }

  function stopScreenAudio() {
    screenAudio.pause();
    screenAudio.srcObject = null;
    if (el.screenSound) el.screenSound.hidden = true;
  }

  function paintScreenSound() {
    const on = !screenAudio.muted;
    el.screenSound.textContent = on ? '🔊 Sound' : '🔇 Muted';
    el.screenSound.setAttribute('aria-pressed', String(on));
    el.screenSound.title = on ? "Mute the shared screen's sound" : "Unmute the shared screen's sound";
  }

  el.screenSound.addEventListener('click', () => {
    screenAudio.muted = !screenAudio.muted;
    paintScreenSound();
  });
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
        /*
         * Sound from the shared tab or screen. Voice processing is switched off
         * because it is built for speech: echo cancellation and noise
         * suppression would mangle music and the soundtrack of a video.
         */
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          // The sharer keeps hearing their own tab.
          suppressLocalAudioPlayback: false
        },
        // Offer whole-system sound where the browser supports it (Chrome on
        // Windows and ChromeOS), not just a single tab.
        systemAudio: 'include',
        /*
         * Keep this page's own output out of the capture. System sound includes
         * the partner's voice coming out of the speakers, and without this they
         * would hear themselves echoed back. Browsers that do not know the
         * option ignore it.
         */
        restrictOwnAudio: true
      });
    } catch {
      toast('Screen share cancelled');
      socket.emit('screen:stopped');
      return;
    }

    const [video] = screenStream.getVideoTracks();
    const [audio] = screenStream.getAudioTracks();
    // Stopping from the browser's own "stop sharing" bar must tear down too.
    video.addEventListener('ended', () => stopSharing('browser'));

    // Both tracks go on screenStream, so the receiver can tell the screen's
    // sound apart from the voice by which stream it belongs to.
    screenSenders = [pc.addTrack(video, screenStream)];
    if (audio) screenSenders.push(pc.addTrack(audio, screenStream));
    await renegotiate();

    showLocalScreen();
    // Sound is opt-in inside the browser's picker, and easy to miss — say so,
    // rather than letting someone share a video in silence and not know why.
    toast(audio
      ? 'Sharing your screen with sound'
      : 'Sharing without sound — to include it, share again and tick "Share audio" in the picker',
      audio ? 'ok' : '');
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
    if (screenSenders.length && pc) {
      // Video and sound both, or the sound would keep streaming after the
      // picture was gone.
      for (const sender of screenSenders) {
        try { pc.removeTrack(sender); } catch { /* connection already gone */ }
      }
      await renegotiate();
    }
    screenStream = null;
    screenSenders = [];
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
    // Their sound goes with their picture, whichever way the share ended.
    stopScreenAudio();
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
    if (state.phase === 'idle') paintIdle();
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
      const streamToSend = processedStream || localStream;
      for (const track of streamToSend.getTracks()) pc.addTrack(track, streamToSend);
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
    stopPitchMatchTracking();
    el.icebreakerWrap.hidden = true;
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

    // Drives the idle-only welcome and quick links in CSS.
    document.body.dataset.phase = state.phase;
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
    // Translation needs a human voice to translate: one-to-one voice calls.
    $('translate-wrap').hidden = !(live && !inGroup && state.mode !== 'text' && state.aiAvailable);
    if (!live) closeMenus();

    // An empty queue for a while: offer the AI partner instead of a spinner.
    // Repaints while searching must not restart the clock.
    if (!searching) {
      clearTimeout(state.aiOfferTimer);
      state.aiOfferTimer = null;
      $('ai-offer').hidden = true;
    } else if (state.aiAvailable && !state.aiOfferTimer) {
      state.aiOfferTimer = setTimeout(() => {
        if (state.phase === 'searching') $('ai-offer').hidden = false;
      }, 10000);
    }

    el.chatInput.disabled = !live;
    el.send.disabled = !live;
    el.image.disabled = !live;
    if (el.reactionDock) el.reactionDock.hidden = !live;

    if (state.phase === 'idle') paintIdle();
  }

  el.callBtn.addEventListener('click', () => {
    // Space still "clicks" the hidden call button while the AI panel is up.
    if (document.body.dataset.ai) return;
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
    closeMenus();
    socket.emit('block');
    toast('Blocked — you will not be matched again', 'ok');
  });

  el.report.addEventListener('click', () => {
    closeMenus();
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

    // On phones the chat is a closed sheet; a dot on its button says there is
    // something to read without popping the sheet open over the call.
    const chatPane = $('pane-right');
    if (from !== 'me' && from !== 'system' && !chatPane.classList.contains('is-open') &&
        getComputedStyle(chatPane).position === 'absolute') {
      $('toggle-right').classList.add('has-unread');
    }
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

  // -------------------------------------------------------- ambiance soundscapes

  let ambianceAudioNodes = [];
  let ambianceGainNode = null;
  let currentAmbiance = 'none';

  function playAmbiance(type) {
    currentAmbiance = type;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // Clean up active soundscape nodes
    ambianceAudioNodes.forEach((node) => {
      try { node.disconnect(); } catch (e) {}
      if (node.stop) { try { node.stop(); } catch (e) {} }
    });
    ambianceAudioNodes = [];

    if (type === 'none') {
      toast('Ambiance off');
      return;
    }

    const now = audioCtx.currentTime;
    if (!ambianceGainNode) {
      ambianceGainNode = audioCtx.createGain();
      ambianceGainNode.gain.value = parseFloat(el.soundscapeVolume.value || 0.4);
      ambianceGainNode.connect(audioCtx.destination);
    }

    if (type === 'rain') {
      // Pink noise + resonant rain filter
      const bufferSize = audioCtx.sampleRate * 2;
      const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        data[i] = (b0 + b1 + b2) * 0.12;
      }
      const noise = audioCtx.createBufferSource();
      noise.buffer = buffer;
      noise.loop = true;

      const lowpass = audioCtx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 850;

      noise.connect(lowpass);
      lowpass.connect(ambianceGainNode);
      noise.start(now);
      ambianceAudioNodes.push(noise, lowpass);

    } else if (type === 'cafe') {
      // Warm low drone + soft murmur
      const osc1 = audioCtx.createOscillator();
      const osc2 = audioCtx.createOscillator();
      osc1.type = 'triangle';
      osc2.type = 'sine';
      osc1.frequency.value = 130;
      osc2.frequency.value = 195;

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 400;

      osc1.connect(filter);
      osc2.connect(filter);
      filter.connect(ambianceGainNode);
      osc1.start(now);
      osc2.start(now);
      ambianceAudioNodes.push(osc1, osc2, filter);

    } else if (type === 'fire') {
      // Crackle generator
      const bufferSize = audioCtx.sampleRate * 2;
      const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() > 0.985 ? (Math.random() * 2 - 1) * 0.8 : (Math.random() * 2 - 1) * 0.03;
      }
      const noise = audioCtx.createBufferSource();
      noise.buffer = buffer;
      noise.loop = true;

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1200;
      filter.Q.value = 2.0;

      noise.connect(filter);
      filter.connect(ambianceGainNode);
      noise.start(now);
      ambianceAudioNodes.push(noise, filter);

    } else if (type === 'city') {
      // Low synth drone
      const osc = audioCtx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 65;

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 220;

      osc.connect(filter);
      filter.connect(ambianceGainNode);
      osc.start(now);
      ambianceAudioNodes.push(osc, filter);

    } else if (type === 'space') {
      // Binaural cosmic drone
      const osc1 = audioCtx.createOscillator();
      const osc2 = audioCtx.createOscillator();
      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.value = 55;
      osc2.frequency.value = 58;

      osc1.connect(ambianceGainNode);
      osc2.connect(ambianceGainNode);
      osc1.start(now);
      osc2.start(now);
      ambianceAudioNodes.push(osc1, osc2);
    }
  }

  el.soundscapeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = el.soundscapeMenu.hidden;
    closeMenus();
    el.soundscapeMenu.hidden = !open;
  });

  for (const opt of document.querySelectorAll('.soundscape-opt')) {
    opt.addEventListener('click', () => {
      const sound = opt.dataset.ambiance;
      for (const o of document.querySelectorAll('.soundscape-opt')) {
        o.classList.toggle('is-active', o === opt);
      }
      playAmbiance(sound);
      socket.emit('soundscape:sync', { sound, on: sound !== 'none' });
      closeMenus();
      toast(`Atmosphere: ${opt.textContent}`, 'ok');
    });
  }

  el.soundscapeVolume.addEventListener('input', () => {
    if (ambianceGainNode) {
      ambianceGainNode.gain.value = parseFloat(el.soundscapeVolume.value);
    }
  });

  socket.on('soundscape:sync', ({ sound, on }) => {
    if (on && sound) {
      playAmbiance(sound);
      for (const o of document.querySelectorAll('.soundscape-opt')) {
        o.classList.toggle('is-active', o.dataset.ambiance === sound);
      }
      toast(`Partner shared atmosphere: ${sound}`, 'ok');
    } else {
      playAmbiance('none');
      for (const o of document.querySelectorAll('.soundscape-opt')) {
        o.classList.toggle('is-active', o.dataset.ambiance === 'none');
      }
    }
  });

  // ------------------------------------------------------------- YouTube Watch Party

  let ytPlayer = null;
  let isSyncingWatch = false;

  function loadYouTubeScript() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    return new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = () => resolve();
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    });
  }

  function parseYouTubeId(input) {
    if (!input) return null;
    const str = input.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(str)) return str;
    const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
    return match ? match[1] : null;
  }

  async function loadWatchVideo(videoId, remote = false) {
    if (!videoId) return;
    el.watchWrap.hidden = false;
    await loadYouTubeScript();

    if (!ytPlayer) {
      ytPlayer = new YT.Player('watch-player', {
        videoId,
        playerVars: { autoplay: 1, rel: 0, modestbranding: 1 },
        events: {
          onStateChange: (event) => {
            if (isSyncingWatch) return;
            const time = ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() : 0;
            socket.emit('watch:state', { state: event.data, time });
          }
        }
      });
    } else {
      ytPlayer.loadVideoById(videoId);
    }

    if (!remote) {
      socket.emit('watch:load', { videoId });
      toast('Loaded video for Watch Party', 'ok');
    }
  }

  el.watchBtn.addEventListener('click', () => {
    el.watchWrap.hidden = !el.watchWrap.hidden;
  });

  el.watchClose.addEventListener('click', () => {
    el.watchWrap.hidden = true;
    if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
  });

  el.watchLoadBtn.addEventListener('click', () => {
    const id = parseYouTubeId(el.watchUrlInput.value);
    if (id) {
      loadWatchVideo(id, false);
      el.watchUrlInput.value = '';
    } else {
      toast('Please enter a valid YouTube link or ID', 'err');
    }
  });

  socket.on('watch:load', ({ videoId }) => {
    loadWatchVideo(videoId, true);
    toast('Partner started a YouTube Watch Party!', 'ok');
  });

  socket.on('watch:state', ({ state, time }) => {
    if (!ytPlayer) return;
    isSyncingWatch = true;
    if (typeof time === 'number' && Math.abs((ytPlayer.getCurrentTime?.() || 0) - time) > 1.5) {
      ytPlayer.seekTo?.(time, true);
    }
    if (state === YT.PlayerState.PLAYING) ytPlayer.playVideo?.();
    if (state === YT.PlayerState.PAUSED) ytPlayer.pauseVideo?.();
    setTimeout(() => { isSyncingWatch = false; }, 500);
  });

  // -------------------------------------------------------------------- game

  let targetPitch = 150;
  let currentColor = '#00f2fe';
  let isDrawing = false;
  let drawCtx = null;
  let lastX = 0, lastY = 0;

  function initCanvas() {
    const canvas = el.drawCanvas;
    if (!canvas) return;
    drawCtx = canvas.getContext('2d');
    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';

    function getCoords(e) {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
    }

    function startDraw(e) {
      isDrawing = true;
      const { x, y } = getCoords(e);
      lastX = x;
      lastY = y;
    }

    function moveDraw(e) {
      if (!isDrawing || !drawCtx) return;
      e.preventDefault();
      const { x, y } = getCoords(e);
      drawCtx.strokeStyle = currentColor;
      drawCtx.lineWidth = 4;
      drawCtx.beginPath();
      drawCtx.moveTo(lastX, lastY);
      drawCtx.lineTo(x, y);
      drawCtx.stroke();

      socket.emit('draw:path', { fromX: lastX, fromY: lastY, toX: x, toY: y, color: currentColor });
      lastX = x;
      lastY = y;
    }

    function endDraw() {
      isDrawing = false;
    }

    canvas.addEventListener('mousedown', startDraw);
    canvas.addEventListener('mousemove', moveDraw);
    canvas.addEventListener('mouseup', endDraw);
    canvas.addEventListener('mouseleave', endDraw);

    canvas.addEventListener('touchstart', startDraw, { passive: false });
    canvas.addEventListener('touchmove', moveDraw, { passive: false });
    canvas.addEventListener('touchend', endDraw);
  }

  function clearCanvas() {
    if (!drawCtx || !el.drawCanvas) return;
    drawCtx.clearRect(0, 0, el.drawCanvas.width, el.drawCanvas.height);
  }

  el.drawClearBtn.addEventListener('click', () => {
    clearCanvas();
    socket.emit('draw:clear');
  });

  for (const dot of document.querySelectorAll('.color-dot')) {
    dot.addEventListener('click', () => {
      for (const d of document.querySelectorAll('.color-dot')) d.classList.remove('is-active');
      dot.classList.add('is-active');
      currentColor = dot.dataset.color || '#00f2fe';
    });
  }

  socket.on('draw:path', ({ fromX, fromY, toX, toY, color }) => {
    if (!drawCtx) initCanvas();
    drawCtx.strokeStyle = color || '#00f2fe';
    drawCtx.lineWidth = 4;
    drawCtx.beginPath();
    drawCtx.moveTo(fromX, fromY);
    drawCtx.lineTo(toX, toY);
    drawCtx.stroke();
  });

  socket.on('draw:clear', clearCanvas);

  /**
   * Counts down the current trivia question.
   *
   * Driven from the absolute deadline the server sends rather than a local
   * duration, so both players see the same number and a slow network cannot
   * put them out of step. The server is still what actually ends the round;
   * this only shows it coming.
   */
  let triviaCountdownTimer = null;

  function stopTriviaCountdown() {
    if (triviaCountdownTimer) clearInterval(triviaCountdownTimer);
    triviaCountdownTimer = null;
    if (el.triviaTimer) el.triviaTimer.hidden = true;
  }

  function startTriviaCountdown(deadline) {
    stopTriviaCountdown();
    if (!deadline || !el.triviaTimer) return;

    const paint = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      el.triviaTimer.hidden = false;
      el.triviaTimer.textContent = left + 's';
      el.triviaTimer.classList.toggle('is-urgent', left <= 5);
      if (left <= 0) stopTriviaCountdown();
    };

    paint();
    triviaCountdownTimer = setInterval(paint, 250);
  }

  /*
   * The end-of-game bar, shared by every game.
   *
   * One bar rather than a button per game, because the drawing game never
   * finishes at all — a per-game "play again" would simply never appear there.
   * For drawing it offers a fresh word instead, at any point in the round.
   */
  let lastGameType = 'tic-tac-toe';
  let gameEndTimer = null;

  function hideGameEndBar() {
    if (gameEndTimer) clearInterval(gameEndTimer);
    gameEndTimer = null;
    el.gameEndBar.hidden = true;
  }

  function paintGameEndBar(payload) {
    hideGameEndBar();

    if (payload.finished) {
      el.gameAgain.textContent = '↻ Play again';
      el.gameEndBar.hidden = false;
      // Count down to the server's automatic return to the picker, so the
      // panel changing on its own is never a surprise.
      if (payload.resetInMs) {
        const returnsAt = Date.now() + payload.resetInMs;
        const tick = () => {
          const left = Math.max(0, Math.ceil((returnsAt - Date.now()) / 1000));
          el.gameEndNote.textContent = `Back to the games in ${left}s`;
          if (!left) hideGameEndBar();
        };
        tick();
        gameEndTimer = setInterval(tick, 500);
      } else {
        el.gameEndNote.textContent = 'Round over';
      }
      return;
    }

    if (payload.type === 'drawing') {
      el.gameAgain.textContent = '↻ New word';
      el.gameEndNote.textContent = '';
      el.gameEndBar.hidden = false;
    }
  }

  // Either player can restart, and the new round reaches both of them.
  el.gameAgain.addEventListener('click', () => {
    hideGameEndBar();
    socket.emit('game:start', { gameType: lastGameType });
  });

  el.gamePick.addEventListener('click', () => {
    hideGameEndBar();
    showGamePicker();
  });

  function renderBoard(payload) {
    lastGameType = payload.type || 'tic-tac-toe';
    paintGameEndBar(payload);
    el.gameWrap.hidden = false;
    el.gameSelectPane.hidden = true;
    el.gameTTTPane.hidden = true;
    el.gamePMPane.hidden = true;
    el.gameTriviaPane.hidden = true;
    el.gameDrawPane.hidden = true;
    if (el.gameReflexPane) el.gameReflexPane.hidden = true;

    // Switching away from trivia must kill its clock, or it keeps ticking
    // against a panel nobody is looking at.
    if (payload.type !== 'trivia') stopTriviaCountdown();

    if (payload.type === 'reflex') {
      el.gameReflexPane.hidden = false;
      const partnerId = Object.keys(payload.scores || {}).find((id) => id !== socket.id);
      el.reflexRoundBadge.textContent = `Round ${payload.round || 1} / ${payload.maxRounds || 3}`;
      el.reflexScoreMe.textContent = payload.scores?.[socket.id] || 0;
      el.reflexScoreThem.textContent = payload.scores?.[partnerId] || 0;

      const buzzer = el.reflexBuzzerBtn;
      const btnText = el.reflexBuzzerText;

      buzzer.classList.remove('is-active', 'is-waiting', 'is-false-start');

      if (payload.finished) {
        buzzer.disabled = true;
        btnText.textContent = payload.winner === socket.id ? "🏆 YOU WON!" : "THEY WON!";
        el.reflexStatus.textContent = payload.winner === socket.id ? "🎉 Reflex Champion!" : "Better reflexes next time!";
        el.reflexLatency.textContent = "Game Complete!";
      } else {
        buzzer.disabled = false;
        const now = Date.now();
        const timeUntilTrigger = (payload.triggerAt || now) - now;

        if (timeUntilTrigger > 0) {
          buzzer.classList.add('is-waiting');
          btnText.textContent = "READY...";
          el.reflexStatus.textContent = "Wait for buzzer to turn green — do NOT tap early!";
          
          if (window._reflexTimer) clearTimeout(window._reflexTimer);
          window._reflexTimer = setTimeout(() => {
            if (el.gameReflexPane && !el.gameReflexPane.hidden) {
              buzzer.classList.remove('is-waiting');
              buzzer.classList.add('is-active');
              btnText.textContent = "🟢 TAP NOW!";
              el.reflexStatus.textContent = "⚡ TAP AS FAST AS YOU CAN!";
            }
          }, timeUntilTrigger);
        } else {
          buzzer.classList.add('is-active');
          btnText.textContent = "🟢 TAP NOW!";
          el.reflexStatus.textContent = "⚡ TAP AS FAST AS YOU CAN!";
        }

        if (payload.roundWinner) {
          const wonRound = payload.roundWinner === socket.id;
          const myTap = payload.tapped?.[socket.id];
          if (myTap === -1) {
            buzzer.classList.add('is-false-start');
            el.reflexLatency.textContent = "⚠️ False start! Tapped too early.";
          } else if (myTap > 0) {
            el.reflexLatency.textContent = wonRound ? `⚡ Fast reaction: ${myTap}ms!` : `Partner was faster!`;
          }
        }
      }
    } else if (payload.type === 'pitch-match') {
      el.gamePMPane.hidden = false;
      targetPitch = payload.targetPitch;
      el.pitchTargetHz.textContent = `Target: ${targetPitch} Hz`;
      const pct = ((targetPitch - 90) / (310 - 90)) * 100;
      el.pitchTargetZone.style.left = Math.max(0, Math.min(85, pct - 7.5)) + "%";

      if (payload.finished) {
        stopPitchMatchTracking();
        el.pitchLockBtn.hidden = true;
        el.pitchPMStatus.textContent = payload.winner === 'draw'
          ? "It's a draw! Both matched pitch."
          : (payload.winner === socket.id ? "You won! Closer pitch match." : "They won! Closer pitch match.");
      } else {
        if (payload.yourTurn) {
          el.pitchPMStatus.textContent = "Your turn! Hum to match the target.";
          el.pitchLockBtn.hidden = false;
          startPitchMatchTracking();
        } else {
          el.pitchPMStatus.textContent = "Their turn... waiting for match.";
          el.pitchLockBtn.hidden = true;
          stopPitchMatchTracking();
        }
      }
    } else if (payload.type === 'trivia') {
      el.gameTriviaPane.hidden = false;
      const qIndex = payload.currentIndex || 0;
      const currentQ = payload.questions?.[qIndex];

      el.triviaQNum.textContent = `Question ${qIndex + 1} / ${payload.questions?.length || 5}`;
      const partnerId = Object.keys(payload.scores || {}).find((id) => id !== socket.id);
      el.triviaScoreMe.textContent = payload.scores?.[socket.id] || 0;
      el.triviaScoreThem.textContent = payload.scores?.[partnerId] || 0;

      if (payload.finished) {
        stopTriviaCountdown();
        el.triviaQuestion.textContent = "Trivia Battle Finished!";
        el.triviaOptions.innerHTML = '';
        el.triviaStatus.textContent = payload.winner === 'draw'
          ? "It's a tie!"
          : (payload.winner === socket.id ? "🎉 You Won the Trivia Battle!" : "They Won the Trivia Battle!");
      } else if (currentQ) {
        // Re-armed on every round, so it follows the server's clock exactly.
        startTriviaCountdown(payload.deadline);
        el.triviaQuestion.textContent = currentQ.q;
        el.triviaOptions.innerHTML = '';
        const myAnswer = payload.answers?.[socket.id];

        currentQ.options.forEach((optText, index) => {
          const btn = document.createElement('button');
          btn.className = 'trivia-opt';
          btn.textContent = optText;
          if (myAnswer !== null && myAnswer !== undefined) {
            btn.disabled = true;
            if (myAnswer === index) btn.classList.add('selected');
          }
          btn.addEventListener('click', () => {
            socket.emit('game:move', { answerIndex: index });
          });
          el.triviaOptions.appendChild(btn);
        });

        el.triviaStatus.textContent = myAnswer !== null && myAnswer !== undefined
          ? "Waiting for partner to answer…"
          : "Choose your answer!";
      }

    } else if (payload.type === 'drawing') {
      el.gameDrawPane.hidden = false;
      if (!drawCtx) initCanvas();
      if (payload.isDrawer) {
        el.drawWordBadge.textContent = `Draw this: ${payload.word}`;
        el.drawTools.hidden = false;
        el.drawStatus.textContent = "Draw the word for your partner to guess in chat!";
      } else {
        el.drawWordBadge.textContent = "Guess the drawing in chat!";
        el.drawTools.hidden = true;
        el.drawStatus.textContent = "Type your guesses in the chat pane on the right!";
      }

    } else {
      el.gameTTTPane.hidden = false;
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
  }

  /** Returns the panel to the game picker, hiding whichever game was open. */
  function showGamePicker() {
    el.gameWrap.hidden = false;
    el.gameSelectPane.hidden = false;
    el.gameTTTPane.hidden = true;
    el.gamePMPane.hidden = true;
    el.gameTriviaPane.hidden = true;
    el.gameDrawPane.hidden = true;
    if (el.gameReflexPane) el.gameReflexPane.hidden = true;
    stopTriviaCountdown();
    hideGameEndBar();
  }

  el.game.addEventListener('click', () => {
    if (el.gameWrap.hidden) showGamePicker();
    else el.gameWrap.hidden = true;
  });

  /*
   * The server clears a finished game after a few seconds and says so. Without
   * this the final scoreboard simply stayed on screen forever, with no way
   * back to pick another game.
   */
  socket.on('game:closed', () => {
    // Someone who already chose "Pick another game" is on the picker; telling
    // them again that the game is over would just be noise.
    const alreadyPicking = !el.gameWrap.hidden && !el.gameSelectPane.hidden;
    showGamePicker();
    if (!alreadyPicking) toast('Game over — pick another');
  });

  el.gameSelectTTT.addEventListener('click', () => {
    socket.emit('game:start', { gameType: 'tic-tac-toe' });
    el.gameSelectPane.hidden = true;
  });

  el.gameSelectPM.addEventListener('click', () => {
    socket.emit('game:start', { gameType: 'pitch-match' });
    el.gameSelectPane.hidden = true;
  });

  el.gameSelectTrivia.addEventListener('click', () => {
    socket.emit('game:start', { gameType: 'trivia' });
    el.gameSelectPane.hidden = true;
  });

  el.gameSelectDraw.addEventListener('click', () => {
    socket.emit('game:start', { gameType: 'drawing' });
    el.gameSelectPane.hidden = true;
  });

  el.gameSelectReflex?.addEventListener('click', () => {
    socket.emit('game:start', { gameType: 'reflex' });
    el.gameSelectPane.hidden = true;
  });

  el.reflexBuzzerBtn?.addEventListener('click', () => {
    socket.emit('game:move', { timestamp: Date.now() });
  });

  el.pitchLockBtn.addEventListener('click', () => {
    socket.emit('game:move', { difference: Math.abs(currentPitchHz - targetPitch) });
    el.pitchLockBtn.hidden = true;
  });

  // --------------------------------------------------------- Themed Lounges

  function renderLounges(lounges) {
    if (!el.loungesList) return;
    el.loungesList.innerHTML = '';

    lounges.forEach((lounge) => {
      const card = document.createElement('div');
      card.className = 'lounge-card';

      card.innerHTML = `
        <div class="lounge-card-top">
          <div class="lounge-icon">${lounge.icon}</div>
          <div class="lounge-info">
            <div class="lounge-title">${escapeHtml(lounge.name)}</div>
            <div class="lounge-desc">${escapeHtml(lounge.desc)}</div>
          </div>
        </div>
        <div class="lounge-card-bottom">
          <span class="lounge-meta">🟢 ${lounge.membersCount} / ${lounge.capacity} online</span>
          <div style="display:flex; gap: 6px;">
            <button class="btn btn-ghost btn-sm lounge-share-btn" title="Copy Invite Link">🔗</button>
            <button class="btn btn-gradient btn-sm lounge-join-btn">Join</button>
          </div>
        </div>
      `;

      card.querySelector('.lounge-share-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const url = `${location.origin}/app?lounge=${lounge.id}`;
        navigator.clipboard?.writeText(url).then(() => {
          toast('📋 Direct lounge invite link copied to clipboard!', 'ok');
        }).catch(() => toast(url));
      });

      card.querySelector('.lounge-join-btn').addEventListener('click', async () => {
        try {
          await ensureMic();
          if (audioCtx?.state === 'suspended') await audioCtx.resume();
        } catch {
          toast('Microphone access is required to join a lounge', 'err');
          return;
        }

        state.phase = 'searching';
        paintPhase();
        setStatus(`Joining <strong>${escapeHtml(lounge.name)}</strong>…`);
        socket.emit('lounges:join', { loungeId: lounge.id });
      });

      el.loungesList.appendChild(card);
    });
  }

  // Custom Lounge Modal Form
  el.btnCreateLounge?.addEventListener('click', () => {
    el.createLoungeModal.showModal();
  });
  el.loungeCancelBtn?.addEventListener('click', () => {
    el.createLoungeModal.close();
  });
  el.loungeSubmitBtn?.addEventListener('click', () => {
    const name = el.loungeNameInput.value.trim();
    const desc = el.loungeDescInput.value.trim();
    const icon = el.loungeIconInput.value.trim() || '✨';
    if (!name) {
      toast('Please enter a lounge title', 'err');
      return;
    }
    socket.emit('lounges:create', { name, desc, icon, tags: ['custom'] });
    el.createLoungeModal.close();
    el.loungeNameInput.value = '';
    el.loungeDescInput.value = '';
    toast('Custom lounge launched!', 'ok');
  });

  socket.on('lounges:created', (lounge) => {
    toast(`Lounge "${lounge.name}" created!`, 'ok');
  });

  socket.on('lounges:list', (list) => renderLounges(list));

  // -------------------------------------------------------------- AI partner

  /**
   * A voice conversation with an AI persona, for an empty queue or practice.
   *
   * It runs entirely beside the call machinery rather than inside it: the
   * phase stays 'idle', and body[data-ai] swaps the stage over to the AI panel.
   * Ending an AI chat therefore can never leave a half-torn-down human call.
   */
  const ai = { personas: {}, maxMs: 0, active: false, ready: false, persona: null,
    stream: null, capture: null, player: null, deadline: 0, tick: null, lastFrom: null, line: null };
  const aiEl = {
    open: $('ai-open'), offer: $('ai-offer'), call: $('ai-call'), pick: $('ai-pick'),
    grid: $('persona-grid'), cancel: $('ai-cancel'), live: $('ai-live'), orb: $('ai-orb'),
    emoji: $('ai-emoji'), name: $('ai-name'), status: $('ai-state'), transcript: $('ai-transcript'),
    mute: $('ai-mute'), muteLabel: $('ai-mute-label'), end: $('ai-end'), timer: $('ai-timer')
  };

  const AI_END_MESSAGES = {
    time_limit: 'Time is up for this AI chat. Start another any time.',
    busy: 'The AI partner is busy right now. Try again in a minute.',
    unavailable: 'The AI partner is not available right now.',
    in_call: 'Finish your call first.',
    closed: 'The AI chat was disconnected.'
  };

  function renderPersonas() {
    aiEl.grid.textContent = '';
    for (const [key, p] of Object.entries(ai.personas)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'persona-card';
      btn.innerHTML = `<span class="persona-emoji" aria-hidden="true">${escapeHtml(p.emoji)}</span>` +
        `<span class="persona-name">${escapeHtml(p.name)}</span>` +
        `<span class="persona-label">${escapeHtml(p.label)}</span>`;
      btn.addEventListener('click', () => startAi(key));
      aiEl.grid.appendChild(btn);
    }
  }

  function openAiPicker() {
    if (state.phase === 'searching') {
      socket.emit('cancel');
      state.phase = 'idle';
      paintPhase();
    }
    if (state.phase !== 'idle') return;
    closeSheets();
    document.body.dataset.ai = 'pick';
    aiEl.call.hidden = false;
    aiEl.pick.hidden = false;
    aiEl.live.hidden = true;
  }

  function closeAi() {
    stopAiAudio();
    delete document.body.dataset.ai;
    aiEl.call.hidden = true;
  }

  function stopAiAudio() {
    if (ai.active) socket.emit('ai:stop');
    ai.active = false;
    ai.ready = false;
    ai.capture?.close();
    ai.player?.close();
    ai.stream?.getTracks().forEach((t) => t.stop());
    ai.capture = ai.player = ai.stream = null;
    clearInterval(ai.tick);
    aiEl.orb.classList.remove('is-speaking');
  }

  async function startAi(key) {
    const p = ai.personas[key];
    if (!p) return;
    ai.persona = p;
    document.body.dataset.ai = 'live';
    aiEl.pick.hidden = true;
    aiEl.live.hidden = false;
    aiEl.emoji.textContent = p.emoji;
    aiEl.name.textContent = p.name;
    aiEl.status.textContent = 'Connecting…';
    aiEl.transcript.textContent = '';
    aiEl.timer.textContent = '';
    ai.lastFrom = null;
    setAiMuted(false);

    // Created inside the click, before any await, so the browser lets it play.
    ai.player = FTLive.player({
      onSpeaking(on) {
        aiEl.orb.classList.toggle('is-speaking', on);
        if (ai.ready) aiEl.status.textContent = on ? `${p.name} is talking…` : 'Listening… just speak';
        // Its own voice leaking back into the mic must not count as the user
        // interrupting it; a deliberate cut-in is louder and still gets through.
        ai.capture?.setGate(on ? 0.12 : 0);
      }
    });

    try {
      ai.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      ai.capture = await FTLive.capture(ai.stream, (buf) => {
        if (ai.active) socket.emit('ai:audio', buf);
      });
    } catch {
      toast('Allow the microphone to talk to the AI', 'err');
      stopAiAudio();
      return openAiPicker();
    }
    ai.active = true;
    socket.emit('ai:start', { persona: key });
  }

  function setAiMuted(muted) {
    ai.muted = muted;
    ai.capture?.setMuted(muted);
    aiEl.mute.setAttribute('aria-pressed', String(muted));
    aiEl.mute.classList.toggle('is-active', muted);
    aiEl.muteLabel.textContent = muted ? 'Unmute' : 'Mute';
  }

  function addAiLine(from, text) {
    if (from !== ai.lastFrom || !ai.line) {
      ai.line = document.createElement('p');
      ai.line.className = 'ai-line ' + from;
      aiEl.transcript.appendChild(ai.line);
      ai.lastFrom = from;
      while (aiEl.transcript.children.length > 6) aiEl.transcript.firstChild.remove();
    }
    ai.line.textContent += text;
    aiEl.transcript.scrollTop = aiEl.transcript.scrollHeight;
  }

  aiEl.open.addEventListener('click', openAiPicker);
  aiEl.offer.addEventListener('click', openAiPicker);
  aiEl.cancel.addEventListener('click', closeAi);
  aiEl.end.addEventListener('click', closeAi);
  aiEl.mute.addEventListener('click', () => setAiMuted(!ai.muted));

  socket.on('ai:ready', () => {
    ai.ready = true;
    aiEl.status.textContent = 'Listening… just speak';
    ai.deadline = Date.now() + (ai.maxMs || 600000);
    clearInterval(ai.tick);
    const paint = () => { aiEl.timer.textContent = `${formatDuration(ai.deadline - Date.now())} left`; };
    paint();
    ai.tick = setInterval(paint, 1000);
  });
  socket.on('ai:audio', (buf) => ai.player?.play(buf));
  socket.on('ai:interrupted', () => ai.player?.flush());
  socket.on('ai:turn', () => { ai.lastFrom = null; });
  socket.on('ai:transcript', ({ from, text }) => { if (ai.active) addAiLine(from, text); });
  socket.on('ai:end', ({ reason } = {}) => {
    const wasActive = ai.active;
    ai.active = false; // the server already closed it; do not send ai:stop
    stopAiAudio();
    if (AI_END_MESSAGES[reason]) toast(AI_END_MESSAGES[reason], reason === 'time_limit' ? '' : 'err');
    if (!wasActive || reason === 'ended') return;
    if (reason === 'unavailable' || reason === 'in_call') closeAi();
    else openAiPicker();
  });

  // -------------------------------------------------------- live translation

  /**
   * Hear the other person in your own language.
   *
   * What gets translated is the audio this browser *receives* — the partner's
   * microphone and connection are untouched, and only the listener who turned
   * it on hears the result. Their original voice is turned down, not off, so
   * tone and laughter still come through under the translation.
   */
  const tr = { on: false, pending: false, capture: null, player: null, text: '', lastAt: 0, volume: 1 };
  const trEl = {
    wrap: $('translate-wrap'), btn: $('btn-translate'), menu: $('translate-menu'),
    target: $('translate-target'), toggle: $('translate-toggle')
  };

  function paintTranslate() {
    const busy = tr.on || tr.pending;
    trEl.btn.classList.toggle('is-active', tr.on);
    trEl.btn.setAttribute('aria-pressed', String(tr.on));
    trEl.toggle.textContent = tr.on ? 'Stop translating' : tr.pending ? 'Connecting…' : 'Start translating';
    trEl.toggle.disabled = tr.pending;
    trEl.target.disabled = busy;
  }

  async function startTranslate() {
    const stream = el.remote.srcObject;
    if (!stream || !stream.getAudioTracks().length) {
      toast('Their voice has not connected yet', 'err');
      return;
    }
    const target = trEl.target.value;
    store.write('translateVoiceTo', target);
    tr.pending = true;
    paintTranslate();
    tr.player = FTLive.player();
    try {
      tr.capture = await FTLive.capture(stream, (buf) => {
        if (tr.on || tr.pending) socket.emit('tr:audio', buf);
      });
    } catch {
      stopTranslate(false);
      toast('This browser cannot translate audio', 'err');
      return;
    }
    socket.emit('translate:start', { target });
  }

  function stopTranslate(tellServer) {
    if (tellServer && (tr.on || tr.pending)) socket.emit('translate:stop');
    if (tr.on) el.remote.volume = tr.volume;
    tr.on = tr.pending = false;
    tr.capture?.close();
    tr.player?.close();
    tr.capture = tr.player = null;
    tr.text = '';
    paintTranslate();
  }

  trEl.btn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = trEl.menu.hidden;
    closeMenus();
    trEl.menu.hidden = !open;
  });
  trEl.toggle.addEventListener('click', () => {
    if (tr.on) stopTranslate(true);
    else if (!tr.pending) startTranslate();
  });

  socket.on('translate:ready', ({ target }) => {
    tr.pending = false;
    tr.on = true;
    tr.volume = el.remote.volume;
    el.remote.volume = 0.2;
    paintTranslate();
    closeMenus();
    toast(`Translating into ${trEl.target.selectedOptions[0]?.textContent || target}`);
  });
  socket.on('tr:audio', (buf) => { if (tr.on) tr.player?.play(buf); });
  socket.on('tr:caption', ({ text }) => {
    if (!tr.on) return;
    // Fragments of one sentence arrive separately; a pause starts a new line.
    if (Date.now() - tr.lastAt > 2500) tr.text = '';
    tr.lastAt = Date.now();
    tr.text = (tr.text + text).slice(-220);
    el.captionThem.textContent = '🌐 ' + tr.text.trim();
    el.captionBar.hidden = false;
  });
  socket.on('translate:end', ({ reason } = {}) => {
    const was = tr.on || tr.pending;
    stopTranslate(false);
    if (!was) return;
    if (reason === 'busy') toast('Translation is busy right now. Try again shortly.', 'err');
    else if (reason === 'unavailable') toast('Live translation is not available right now', 'err');
    else if (reason === 'time_limit') toast('Translation stopped after its time limit. Turn it on again to continue.');
  });
  socket.on('translate:notice', ({ on, language } = {}) => {
    systemMessage(on
      ? `They turned on live translation: an AI is re-speaking your voice in ${language} for them.`
      : 'They turned off live translation.');
  });

  socket.on('ready', (payload) => {
    ai.personas = payload.aiPersonas || {};
    ai.maxMs = payload.aiMaxMs || 0;
    state.aiAvailable = Boolean(window.FTLive?.supported) && Object.keys(ai.personas).length > 0;
    aiEl.open.hidden = !state.aiAvailable;
    renderPersonas();

    const languages = payload.languages || {};
    trEl.target.textContent = '';
    for (const [code, label] of Object.entries(languages)) trEl.target.add(new Option(label, code));
    trEl.target.value = store.read('translateVoiceTo', guessLanguage(languages));
    paintTranslate();
  });

  // ---------------------------------------------------------- socket events

  socket.on('ready', (payload) => {
    state.iceServers = payload.iceServers || [];
    state.selfName = payload.name || 'You';
    paintStats(payload.stats);

    // Caption controls only exist if the server can actually transcribe.
    state.pushKey = payload.pushKey || null;
    // Re-register a subscription the browser already granted, so a returning
    // user does not have to switch it on again.
    if (state.pushKey && store.read('notify', false) && window.Notification?.permission === 'granted') {
      subscribeToPush();
    }

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
      loadIcebreakers(payload.sharedInterests);
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
    el.captionBar.hidden = false;
    
    if (payload.original) {
      target.innerHTML = payload.from === 'me'
        ? `You: <strong>${escapeHtml(payload.text)}</strong><br><small style="opacity: 0.65; font-style: italic;">Original: ${escapeHtml(payload.original)}</small>`
        : `<strong>${escapeHtml(payload.text)}</strong><br><small style="opacity: 0.65; font-style: italic;">Original: ${escapeHtml(payload.original)}</small>`;
    } else {
      target.textContent = payload.from === 'me' ? `You: ${payload.text}` : payload.text;
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

  socket.on('soundboard:trigger', ({ name }) => {
    triggerSynthesizedSound(name);
    toast(`🎵 Played sound: ${name}`);
  });

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
      if (pane === paneRight) $('toggle-right').classList.remove('has-unread');
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
  // Matches the 960px breakpoint where the panes stop being drawers in CSS.
  window.addEventListener('resize', () => {
    if (window.innerWidth > 960) closeSheets();
  });

  // Welcome-screen shortcuts into the sidebar: switch to the tab, and on
  // phones also slide the sheet up, since the sidebar is otherwise hidden.
  for (const link of document.querySelectorAll('.quick-link[data-open]')) {
    link.addEventListener('click', () => {
      document.querySelector(`.tab[data-panel="${link.dataset.open}"]`)?.click();
      if (getComputedStyle(paneLeft).position === 'absolute' &&
          !paneLeft.classList.contains('is-open')) {
        toggleSheet(paneLeft);
      }
    });
  }

  // Sidebar tabs — filters, lounges, recent calls, and friends share one column
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) {
        other.classList.toggle('is-active', other === tab);
      }
      for (const panel of document.querySelectorAll('.panel')) {
        panel.classList.toggle('is-active', panel.id === tab.dataset.panel);
      }
      if (tab.dataset.panel === 'panel-lounges') {
        socket.emit('lounges:list');
      }
    });
  }

  // Report and block live behind an overflow menu. They should be reachable in
  // one tap but not sit next to Mute inviting a misclick.
  function closeMenus() {
    el.moreMenu.hidden = true;
    el.moreBtn.setAttribute('aria-expanded', 'false');
    el.modifierMenu.hidden = true;
    el.soundboardMenu.hidden = true;
    $('translate-menu').hidden = true;
  }

  el.moreBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = el.moreMenu.hidden;
    closeMenus();
    el.moreMenu.hidden = !open;
    el.moreBtn.setAttribute('aria-expanded', String(open));
  });

  el.modifierBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = el.modifierMenu.hidden;
    closeMenus();
    el.modifierMenu.hidden = !open;
  });

  el.soundboardBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = el.soundboardMenu.hidden;
    closeMenus();
    el.soundboardMenu.hidden = !open;
  });

  for (const opt of document.querySelectorAll('.mod-opt')) {
    opt.addEventListener('click', () => {
      const filter = opt.dataset.filter;
      for (const o of document.querySelectorAll('.mod-opt')) {
        o.classList.toggle('is-active', o === opt);
      }
      applyVoiceFilter(filter);
      closeMenus();
      toast(`Voice filter: ${opt.textContent}`, 'ok');
    });
  }

  for (const opt of document.querySelectorAll('.sound-opt')) {
    opt.addEventListener('click', () => {
      const sound = opt.dataset.sound;
      triggerSynthesizedSound(sound);
      socket.emit('soundboard:trigger', { name: sound });
      closeMenus();
      toast(`Played sound: ${opt.textContent}`);
    });
  }

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.overflow')) closeMenus();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenus();
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
        ? 'Screen sharing is not available on phones or tablets — no mobile browser supports it. You can still watch a screen someone else shares with you.'
        : 'This browser does not support screen sharing. You can still watch a screen shared with you.';
    }

    registerServiceWorker();
    setupInstall();

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
    socket.emit('lounges:list');

    el.icebreakerNext.addEventListener('click', () => {
      if (activeIcebreakers.length > 0) {
        currentIcebreakerIndex = (currentIcebreakerIndex + 1) % activeIcebreakers.length;
        showCurrentIcebreaker();
      }
    });

    bootAgeGate();
  }

  // ---------------------------------------------------------- theme toggle

  function initThemeToggle() {
    const btn = $('theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const html = document.documentElement;
      const next = html.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      html.setAttribute('data-theme', next);
      localStorage.setItem('ft:theme', next);
    });
  }

  initThemeToggle();
  boot();
})();

'use strict';
const { Room, RoomEvent, Track, VideoPresets } = LivekitClient;
const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const KNOCK_WAIT_MS = 60_000;

let other = null;
let room = null, inCall = false, poll = null;
let knockTimer = null, leaveTimer = null;
let remoteCam = null, remoteScreen = null;
let flashText = '', flashUntil = 0;

// ---------- small helpers ----------
async function api(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch('/api' + path, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status });
  return j;
}

function setState(state, headline, caption) {
  stage.dataset.state = state;
  if (headline !== undefined) $('#headline').textContent = headline;
  if (caption !== undefined) $('#caption').textContent = Date.now() < flashUntil ? flashText : caption;
  $('#door').setAttribute('aria-label', state === 'incoming' ? 'Open the door' : 'Knock on the door');
  if (state !== 'incoming') document.title = 'The Door';
}

function flash(text) {
  flashText = text;
  flashUntil = Date.now() + 8000;
  $('#caption').textContent = text;
}

function showJoin(message) {
  clearInterval(poll);
  setState('join', 'The Door', message);
}

function friendly(e) {
  if (e?.name === 'NotAllowedError' || /permission|denied/i.test(e?.message || '')) return 'Camera or microphone is blocked. Allow both for this site, then knock again.';
  if (e?.name === 'NotFoundError') return 'No camera or microphone was found on this device.';
  return e?.message || 'Something went wrong.';
}

function setPressed(sel, pressed, labelOn, labelOff) {
  const b = $(sel);
  b.setAttribute('aria-pressed', String(pressed));
  b.setAttribute('aria-label', pressed ? labelOn : labelOff);
}

// ---------- the door (status polling) ----------
async function refresh() {
  if (inCall) return; // no need to ask the server while the call is open
  let s;
  try {
    s = await api('/status');
  } catch (e) {
    if (e.status === 401 && !inCall) showJoin('Open the invite link you were sent to get in.');
    else if (stage.dataset.state === 'loading') setState('loading', 'The Door', 'Trying to reach the door…');
    return;
  }
  other = s.other;
  if (inCall) return;
  const name = other?.name || 'Someone';
  if (s.incoming) {
    if (stage.dataset.state !== 'incoming') {
      navigator.vibrate?.([200, 100, 200]);
      document.title = `${name} is at the door`;
    }
    setState('incoming', `${name} is at the door`, 'Tap the door to open it');
  } else if (!other) {
    setState('idle', 'The Door', 'The other half of this door has not joined yet.');
  } else if (other.online) {
    setState('online', `${name} is here`, 'Tap the door to knock');
  } else {
    setState('idle', 'The Door', `${name} is not here right now. Tap the door to knock anyway.`);
  }
}

$('#door').addEventListener('click', async () => {
  if (inCall) return;
  const state = stage.dataset.state;
  try {
    if (state === 'incoming') {
      const a = await api('/answer', {});
      if (!a.ok) { flash('They stopped knocking.'); return refresh(); }
      await joinCall({ knocking: false });
    } else if (state === 'idle' || state === 'online') {
      const k = await api('/knock', {});
      await joinCall({ knocking: !k.answered });
    }
  } catch (e) {
    flash(friendly(e));
  }
});

// ---------- the call ----------
const hasPeer = () => Boolean(room && room.remoteParticipants.size > 0);

function onPeer() {
  clearTimeout(knockTimer);
  clearTimeout(leaveTimer);
  $('#call').dataset.peer = '1';
}

function renderRemote() {
  const v = $('#remote');
  if (remoteScreen && remoteCam) remoteCam.detach(v);
  $('#call').dataset.screen = remoteScreen ? '1' : '0';
  (remoteScreen || remoteCam)?.attach(v);
}

function wireRoom(r) {
  r.on(RoomEvent.ParticipantConnected, onPeer);
  r.on(RoomEvent.ParticipantDisconnected, () => {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => { if (inCall && !hasPeer()) endCall(`${other?.name || 'They'} closed the door.`); }, 6000);
  });
  r.on(RoomEvent.TrackSubscribed, (track, pub) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      el.dataset.remote = '1';
      document.body.append(el);
      return;
    }
    if (pub.source === Track.Source.ScreenShare) remoteScreen = track; else remoteCam = track;
    renderRemote();
  });
  r.on(RoomEvent.TrackUnsubscribed, (track, pub) => {
    const els = track.detach();
    if (track.kind === Track.Kind.Audio) { els.forEach((e) => e.remove()); return; }
    if (pub.source === Track.Source.ScreenShare) remoteScreen = null; else remoteCam = null;
    renderRemote();
  });
  r.on(RoomEvent.LocalTrackUnpublished, (pub) => {
    if (pub.source === Track.Source.ScreenShare) setPressed('#share', false, 'Stop sharing', 'Share screen');
  });
  r.on(RoomEvent.Disconnected, () => { if (inCall) endCall('The connection dropped. Knock again to reconnect.'); });
}

async function joinCall({ knocking }) {
  inCall = true;
  $('#scene').hidden = true;
  $('#call').hidden = false;
  delete $('#call').dataset.peer;
  $('#call-status').textContent = knocking ? `Knocking… waiting for ${other?.name || 'them'}` : 'Opening the door…';
  try {
    const { token, url } = await api('/token', {});
    room = new Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: { resolution: VideoPresets.h540.resolution, facingMode: 'user' },
    });
    wireRoom(room);
    await room.connect(url, token);
    await room.localParticipant.setMicrophoneEnabled(true);
    await room.localParticipant.setCameraEnabled(true);
    room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack?.attach($('#local'));
    const cams = await Room.getLocalDevices('videoinput').catch(() => []);
    $('#flip').hidden = cams.length < 2;
    $('#share').hidden = !navigator.mediaDevices?.getDisplayMedia;
    if (hasPeer()) onPeer();
    if (knocking) {
      knockTimer = setTimeout(() => {
        if (inCall && !hasPeer()) endCall(`${other?.name || 'They'} cannot come to the door right now. They will see you knocked.`);
      }, KNOCK_WAIT_MS);
    }
  } catch (e) {
    await endCall(friendly(e));
  }
}

async function endCall(message) {
  if (!inCall) return;
  inCall = false;
  clearTimeout(knockTimer);
  clearTimeout(leaveTimer);
  const r = room;
  room = null;
  remoteCam = remoteScreen = null;
  try { await r?.disconnect(); } catch { /* already gone */ }
  document.querySelectorAll('audio[data-remote]').forEach((e) => e.remove());
  $('#local').srcObject = null;
  $('#remote').srcObject = null;
  $('#local').classList.remove('rear');
  api('/hangup', {}).catch(() => {});
  setPressed('#mic', false, 'Unmute microphone', 'Mute microphone');
  setPressed('#cam', false, 'Turn camera on', 'Turn camera off');
  setPressed('#share', false, 'Stop sharing', 'Share screen');
  $('#call').hidden = true;
  delete $('#call').dataset.peer;
  $('#scene').hidden = false;
  if (message) flash(message);
  setState('idle');
  refresh();
}

$('#hangup').addEventListener('click', () => endCall());

$('#mic').addEventListener('click', async () => {
  if (!room) return;
  const wasOn = room.localParticipant.isMicrophoneEnabled;
  await room.localParticipant.setMicrophoneEnabled(!wasOn);
  setPressed('#mic', wasOn, 'Unmute microphone', 'Mute microphone');
});

$('#cam').addEventListener('click', async () => {
  if (!room) return;
  const wasOn = room.localParticipant.isCameraEnabled;
  await room.localParticipant.setCameraEnabled(!wasOn);
  if (!wasOn) room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack?.attach($('#local'));
  setPressed('#cam', wasOn, 'Turn camera on', 'Turn camera off');
});

$('#flip').addEventListener('click', async () => {
  if (!room) return;
  const cams = await Room.getLocalDevices('videoinput');
  if (cams.length < 2) return;
  const i = (cams.findIndex((c) => c.deviceId === room.getActiveDevice('videoinput')) + 1) % cams.length;
  await room.switchActiveDevice('videoinput', cams[i].deviceId);
  const facing = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack.getSettings().facingMode;
  $('#local').classList.toggle('rear', facing === 'environment'); // only mirror the front camera
});

$('#share').addEventListener('click', async () => {
  if (!room) return;
  const wasOn = room.localParticipant.isScreenShareEnabled;
  try { await room.localParticipant.setScreenShareEnabled(!wasOn); } catch { return; /* cancelled */ }
  setPressed('#share', !wasOn, 'Stop sharing', 'Share screen');
});

// ---------- knock notifications ----------
const b64ToU8 = (s) => {
  const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function subscribe(reg) {
  const { key } = await api('/push/key');
  if (!key) return;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(key) }));
  await api('/push/subscribe', { subscription: sub.toJSON() });
}

async function setupPush() {
  const hint = $('#hint');
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.register('/sw.js');
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (!('PushManager' in window) || !('Notification' in window)) {
      if (ios && !installed) {
        hint.textContent = 'On iPhone: tap Share, then Add to Home Screen, and open the door from that icon to get knocks.';
        hint.hidden = false;
      }
      return;
    }
    if (Notification.permission === 'granted') return void (await subscribe(reg));
    if (Notification.permission === 'default') {
      const btn = $('#notify-btn');
      btn.hidden = false;
      btn.addEventListener('click', async () => {
        if ((await Notification.requestPermission()) === 'granted') { await subscribe(reg); btn.hidden = true; }
      });
    }
  } catch (e) {
    console.warn('Knock notifications unavailable:', e.message);
  }
}

// ---------- start ----------
async function init() {
  const code = new URLSearchParams(location.search).get('invite');
  if (code) {
    try { await api('/join', { code }); } catch (e) { history.replaceState(null, '', '/'); return showJoin(e.message); }
    history.replaceState(null, '', '/');
  }
  await refresh();
  if (stage.dataset.state === 'join') return;
  poll = setInterval(() => { if (!document.hidden) refresh(); }, 5000); // idle tabs stay quiet; push covers them
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setupPush();
}

init();

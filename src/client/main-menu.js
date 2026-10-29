// Title screen and LAN co-op lobby (the #mainmenu overlay). Picks a mode, then
// hands main.js what it needs to start: { map, seed?, session? }.
//
// Finding each other (net/discovery.js): a host advertises its farm in its
// network's room (worked out from the public IP everyone behind the router
// shares) and in a 4-character room code. Joiners see nearby farms listed by
// themselves, or type the code. That handshake goes through a public relay
// (net/relay.js); the game link itself is direct and LAN-only (net/peer.js).
// With no internet, the old invite link + reply code still works by hand.

import { FARMER_COLORS, HostSession, JoinSession, MAX_FARMERS, cleanName } from '../net/session.js';
import { acceptInvite, createInvite, lanSupported, publicNetworkId } from '../net/peer.js';
import { relayFromParams } from '../net/relay.js';
import { Finder, HostBeacon, newRoomCode, normalizeCode, roomTopic } from '../net/discovery.js';

const NAME_KEY = 'goofytd.name';
const GOOFY_NAMES = ['Cletus', 'Marge', 'Dale', 'Bessie', 'Earl', 'Ruth', 'Hank', 'Mabel', 'Jebediah', 'Opal'];
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
/** Joining by room code: how long to look for the farm before giving up (ms). */
const CODE_WAIT_MS = 8000;

/** Manual invite as a link: opening it lands on the join screen with the code filled in. */
export function inviteLink(code, loc = location) {
  return `${loc.origin}${loc.pathname}#join=${code}`;
}

/** Room code as a link: opening it joins that farm. */
export function roomLink(code, loc = location) {
  return `${loc.origin}${loc.pathname}#room=${code}`;
}

export class MainMenu {
  /**
   * @param {HTMLElement} root #mainmenu
   * @param {{ play: (opts: {map: string, seed?: number, session?: object}) => void, newSeed: () => number }} hooks
   */
  constructor(root, { play, newSeed }) {
    this.root = root;
    this.play = play;
    this.newSeed = newSeed;
    this.params = new URLSearchParams(location.search);
    this.relay = relayFromParams(this.params);
    this.session = null;
    this.invite = null;
    this.joinLink = null;
    this.beacon = null;
    this.finders = [];
    this.netId = undefined; // undefined: not asked yet; null: unknown
    this.$ = (n) => root.querySelector(`[data-mm=${n}]`);
    this.nameEl = this.$('name');
    let saved = '';
    try { saved = localStorage.getItem(NAME_KEY) ?? ''; } catch { /* storage blocked: fine */ }
    this.nameEl.value = saved || GOOFY_NAMES[Math.floor(Math.random() * GOOFY_NAMES.length)];
    this.nameEl.addEventListener('change', () => {
      try { localStorage.setItem(NAME_KEY, cleanName(this.nameEl.value)); } catch { /* ignore */ }
    });
    root.addEventListener('click', (e) => {
      const b = e.target.closest?.('button[data-mm]');
      if (b && !b.disabled) this.onClick(b.dataset.mm, b);
    });
    // Keys typed into the name or code boxes are for the menu, not the game.
    root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && e.target === this.$('codeIn')) this.joinByCode();
    });
    if (!navigator.share) for (const n of ['shareInvite', 'shareReply']) this.$(n).hidden = true;
  }

  get name() { return cleanName(this.nameEl.value); }

  /** Show the title screen, or jump to joining if the page was opened from a room or invite link. */
  show() {
    this.root.hidden = false;
    const room = /room=([^&]+)/.exec(location.hash);
    const join = /join=([^&]+)/.exec(location.hash);
    if (room || join) history.replaceState(null, '', location.pathname + location.search); // a reload shouldn't rejoin
    if (room) this.showJoin({ code: decodeURIComponent(room[1]) });
    else if (join) this.showJoin({ invite: decodeURIComponent(join[1]) });
    else this.screen('home');
  }

  screen(name) {
    for (const s of this.root.querySelectorAll('[data-screen]')) s.hidden = s.dataset.screen !== name;
  }

  onClick(what, el) {
    switch (what) {
      case 'solo': this.launch({ map: 'field' }); break;
      case 'playground': this.launch({ map: 'playground' }); break;
      case 'host': this.showHost(); break;
      case 'join': this.showJoin({}); break;
      case 'back': this.leave(); break;
      case 'invite': this.newInvite(); break;
      case 'connect': this.connect(); break;
      case 'start': this.startHosted(); break;
      case 'makeReply': this.makeReply(); break;
      case 'farm': this.joinFarm(el.dataset.finder | 0, el.dataset.id); break;
      case 'joinCode': this.joinByCode(); break;
      case 'shareRoom': this.share(roomLink(this.roomCode), this.$('shareRoom')); break;
      case 'copyInvite': this.copy(this.$('inviteOut'), this.$('copyInvite')); break;
      case 'shareInvite': this.share(this.$('inviteOut').value); break;
      case 'copyReply': this.copy(this.$('replyOut'), this.$('copyReply')); break;
      case 'shareReply': this.share(this.$('replyOut').value); break;
    }
  }

  launch(opts) {
    try { localStorage.setItem(NAME_KEY, this.name); } catch { /* ignore */ }
    this.stopLooking();
    this.root.hidden = true;
    this.play(opts);
  }

  status(screen, text, tone = '') {
    const el = this.$(screen === 'host' ? 'hostStatus' : 'joinStatus');
    el.textContent = text;
    el.className = `mm-status ${tone}`;
  }

  /** This network's public identity (asked once per page; ~0.2–2.5 s). */
  async network() {
    if (this.netId === undefined) this.netId = this.params.get('netid') || await publicNetworkId();
    return this.netId;
  }

  // ---- hosting ------------------------------------------------------------

  async showHost() {
    this.screen('host');
    this.$('inviteBox').hidden = true;
    this.$('hostManual').open = false;
    if (!lanSupported()) { this.status('host', 'This browser has no WebRTC, so it can\'t host.', 'bad'); return; }
    const s = this.session = new HostSession(this.name);
    s.onChange = () => this.renderHost();
    s.onEvent = (e) => {
      if (e.kind === 'joined') this.status('host', `${e.name} joined the farm!`, 'good');
      if (e.kind === 'left') this.status('host', `${e.name} left.`, 'bad');
    };
    this.roomCode = newRoomCode();
    this.$('roomCode').textContent = '····';
    this.$('shareRoom').hidden = true;
    this.renderHost();
    if (!this.relay) { this.noRelay('host'); return; }
    this.status('host', 'Opening the farm gate…');
    const net = await this.network();
    if (this.session !== s) return; // backed out meanwhile
    const topics = [await roomTopic('code', this.roomCode)];
    if (net) topics.push(await roomTopic('net', net));
    if (this.session !== s) return;
    this.$('roomCode').textContent = this.roomCode;
    this.$('shareRoom').hidden = false;
    this.$('roomNote').textContent = net
      ? 'Farmers on your Wi-Fi will see your farm by themselves, or can type this code.'
      : 'Farmers on your Wi-Fi can join with this code.';
    this.beacon = new HostBeacon({
      relay: this.relay,
      topics,
      info: () => ({ name: s.name, players: s.players.length, max: MAX_FARMERS, open: !s.started && !s.full, why: s.full ? 'the farm is full' : 'the game already started' }),
      createInvite,
      onLink: (link) => { if (this.session === s) s.addLink(link); else link.close(); },
      onError: (e) => this.status('host', `A farmer couldn't connect (${e.message})`, 'bad'),
      onState: (st) => {
        if (st === 'open') this.status('host', 'Waiting for farmers…');
        else this.status('host', 'Can\'t reach matchmaking right now. Use an invite link below (works offline).', 'bad');
      },
    });
    this.beacon.start();
  }

  renderHost() {
    const s = this.session;
    if (!s) return;
    const rows = s.players.map((p) =>
      `<li><i style="background:${hex(FARMER_COLORS[p.color])}"></i>${p.name}<small>${p.id === 0 ? 'host (you)' : 'joined'}</small></li>`);
    for (let k = s.players.length; k < MAX_FARMERS; k++) rows.push('<li class="empty"><i></i>empty spot</li>');
    this.$('players').innerHTML = rows.join('');
    this.$('invite').hidden = !!this.invite || s.full;
    this.$('start').textContent = s.players.length > 1 ? `START GAME (${s.players.length} FARMERS)` : 'START GAME';
  }

  /** Manual fallback: a full invite link the joiner pastes, and their reply code back. */
  async newInvite() {
    const s = this.session;
    if (!s || s.full) return;
    this.invite?.cancel();
    this.invite = null;
    this.$('invite').hidden = true;
    this.status('host', 'Making an invite…');
    try {
      const inv = await createInvite();
      if (this.session !== s) { inv.cancel(); return; }
      this.invite = inv;
      this.$('inviteOut').value = inviteLink(inv.code);
      this.$('replyIn').value = '';
      this.$('inviteBox').hidden = false;
      this.status('host', 'Send the link, then paste the reply code they send back.');
    } catch (e) {
      this.status('host', e.message, 'bad');
    }
    this.renderHost();
  }

  async connect() {
    const inv = this.invite, s = this.session;
    if (!inv) return;
    this.$('connect').disabled = true;
    this.status('host', 'Connecting…');
    try {
      const link = await inv.accept(this.$('replyIn').value);
      if (this.session !== s) { link.close(); return; }
      this.invite = null;
      this.$('inviteBox').hidden = true;
      s.addLink(link);
    } catch (e) {
      this.status('host', e.message, 'bad');
    } finally {
      this.$('connect').disabled = false;
      if (this.session === s) this.renderHost();
    }
  }

  startHosted() {
    const s = this.session;
    if (!s) { this.status('host', 'Hosting needs WebRTC.', 'bad'); return; }
    this.invite?.cancel();
    this.invite = null;
    const { seed, map } = s.start(this.newSeed(), 'field');
    this.launch({ map, seed, session: s });
  }

  // ---- joining ------------------------------------------------------------

  async showJoin({ code = '', invite = '' }) {
    this.screen('join');
    this.$('lookBox').hidden = false;
    this.$('joinPlayers').hidden = true;
    this.$('inviteIn').value = invite;
    this.$('inviteInBox').hidden = false;
    this.$('replyBox').hidden = true;
    this.$('joinManual').open = !!invite;
    this.$('codeIn').value = code;
    this.farmsNote = 'Looking for farms…';
    this.renderFarms();
    if (!lanSupported()) { this.status('join', 'This browser has no WebRTC, so it can\'t join.', 'bad'); return; }
    this.status('join', '');
    if (invite) { this.makeReply(); return; }
    if (!this.relay) { this.noRelay('join'); return; }
    if (code) { this.joinByCode(); return; }
    const token = this.lookToken = {};
    const net = await this.network();
    if (this.lookToken !== token) return;
    if (!net) {
      this.farmsNote = 'Couldn\'t work out your network. Ask the host for their room code.';
      this.renderFarms();
      return;
    }
    this.startFinder([await roomTopic('net', net)], token);
  }

  startFinder(topics, token = this.lookToken) {
    if (this.lookToken !== token) return null;
    const f = new Finder({
      relay: this.relay,
      topics,
      name: this.name,
      acceptInvite,
      onChange: () => this.renderFarms(),
      onState: (st) => {
        this.farmsNote = st === 'open' ? 'Looking for farms on your Wi-Fi…' : 'Can\'t reach matchmaking. Try a room code later, or an invite link (works offline).';
        this.renderFarms();
      },
    });
    this.finders.push(f);
    f.start();
    return f;
  }

  renderFarms() {
    const rows = [];
    this.finders.forEach((f, k) => {
      if (f.codeOnly) return;
      for (const h of f.hosts.values()) {
        rows.push(`<li><button data-mm="farm" data-finder="${k}" data-id="${h.id}"${h.players >= h.max ? ' disabled' : ''}>`
          + `${h.name}'s farm<small>${h.players}/${h.max} · JOIN</small></button></li>`);
      }
    });
    this.$('farms').innerHTML = rows.length ? rows.join('') : `<li class="searching">${this.farmsNote ?? ''}</li>`;
  }

  async joinFarm(k, hostId) {
    const f = this.finders[k];
    if (!f || this.joining) return;
    this.joining = true;
    this.status('join', 'Knocking on the barn door…');
    try {
      const link = await f.connect(hostId);
      this.joinLink = link;
      this.status('join', 'Connecting…');
      await link.opened;
      if (this.joinLink !== link) return;
      this.joinWith(link);
    } catch (e) {
      this.status('join', e.message, 'bad');
    } finally {
      this.joining = false;
    }
  }

  async joinByCode() {
    const code = normalizeCode(this.$('codeIn').value);
    if (!code) { this.status('join', 'Room codes are 4 letters and numbers, like K7QM.', 'bad'); return; }
    if (!this.relay) { this.noRelay('join'); return; }
    if (this.joining) return;
    this.joining = true;
    this.$('joinCode').disabled = true;
    this.status('join', `Looking for farm ${code}…`);
    const token = this.lookToken ??= {};
    const f = this.startFinder([await roomTopic('code', code)], token);
    if (!f) { this.joining = false; this.$('joinCode').disabled = false; return; }
    f.codeOnly = true;
    try {
      const h = await f.firstHost(CODE_WAIT_MS);
      this.joining = false;
      await this.joinFarm(this.finders.indexOf(f), h.id);
    } catch (e) {
      this.status('join', e.message, 'bad');
      f.stop();
      this.finders = this.finders.filter((x) => x !== f);
    } finally {
      this.joining = false;
      this.$('joinCode').disabled = false;
    }
  }

  /** Manual fallback: the host's long invite → our reply code. */
  async makeReply() {
    this.joinLink?.close();
    this.joinLink = null;
    this.$('makeReply').disabled = true;
    this.status('join', 'Reading the invite…');
    let link;
    try {
      const r = await acceptInvite(this.$('inviteIn').value);
      link = this.joinLink = r.link;
      this.$('replyOut').value = r.code;
      this.$('replyBox').hidden = false;
      this.$('inviteInBox').hidden = true;
      this.status('join', 'Send the reply code to the host. Waiting for them to paste it…');
      await link.opened;
    } catch (e) {
      if (link && this.joinLink !== link) return; // backed out meanwhile
      this.status('join', e.message, 'bad');
      this.$('inviteInBox').hidden = false;
      return;
    } finally {
      this.$('makeReply').disabled = false;
    }
    if (this.joinLink !== link) return;
    this.joinWith(link);
  }

  /** Connected to a host (any route): wait in their lobby. */
  joinWith(link) {
    this.stopLooking();
    const s = this.session = new JoinSession(this.name, link);
    s.onChange = () => this.renderJoin();
    s.onEvent = (e) => {
      if (e.kind === 'hostLost' && !s.started) this.status('join', 'The host closed the lobby.', 'bad');
      if (e.kind === 'full') this.status('join', `Can't join: ${e.why}.`, 'bad');
    };
    s.onStart = ({ seed, map }) => this.launch({ map, seed, session: s });
    this.$('lookBox').hidden = true;
    this.$('replyBox').hidden = true;
    this.$('joinManual').open = false;
    this.status('join', 'Connected! Waiting for the host to start the game…', 'good');
    this.renderJoin();
  }

  renderJoin() {
    const s = this.session;
    if (!s) return;
    const el = this.$('joinPlayers');
    el.hidden = !s.players.length;
    el.innerHTML = s.players.map((p) =>
      `<li><i style="background:${hex(FARMER_COLORS[p.color])}"></i>${p.name}<small>${p.id === 0 ? 'host' : p.id === s.me ? 'you' : 'joined'}</small></li>`).join('');
  }

  // ---- shared -------------------------------------------------------------

  noRelay(screen) {
    const text = 'Matchmaking is off (?relay=off). Use an invite link below.';
    if (screen === 'host') { this.status('host', text); this.$('hostManual').open = true; } else {
      this.farmsNote = text;
      this.renderFarms();
      this.$('joinManual').open = true;
    }
  }

  stopLooking() {
    this.lookToken = null;
    for (const f of this.finders) f.stop();
    this.finders = [];
    this.beacon?.stop();
    this.beacon = null;
  }

  leave() {
    this.stopLooking();
    this.invite?.cancel();
    this.invite = null;
    this.session?.close();
    this.session = null;
    this.joinLink?.close();
    this.joinLink = null;
    this.joining = false;
    this.$('inviteBox').hidden = true;
    this.screen('home');
  }

  async copy(textarea, button) {
    const text = textarea.value;
    if (!text) return;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      textarea.select();
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    }
    this.flash(button, ok ? 'COPIED!' : 'SELECT + COPY');
  }

  /** Share sheet where there is one; otherwise copy to the clipboard. */
  async share(text, button) {
    if (!text) return;
    if (navigator.share) { navigator.share({ title: 'CowTD co-op', text }).catch(() => {}); return; }
    try { await navigator.clipboard.writeText(text); if (button) this.flash(button, 'LINK COPIED!'); } catch { /* ignore */ }
  }

  flash(button, text) {
    const was = button.dataset.label ?? (button.dataset.label = button.textContent);
    button.textContent = text;
    setTimeout(() => { button.textContent = was; }, 1500);
  }
}

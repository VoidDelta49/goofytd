// Title screen and LAN co-op lobby (the #mainmenu overlay). Picks a mode, then
// hands main.js what it needs to start: { map, seed?, session? }.
//
// Co-op connects two browsers directly with WebRTC (net/peer.js): the host
// makes an invite link, the joiner opens it and gets a reply code, the host
// pastes that back. Repeat per farmer, up to MAX_FARMERS.

import { FARMER_COLORS, HostSession, JoinSession, MAX_FARMERS, cleanName } from '../net/session.js';
import { acceptInvite, createInvite, lanSupported } from '../net/peer.js';

const NAME_KEY = 'goofytd.name';
const GOOFY_NAMES = ['Cletus', 'Marge', 'Dale', 'Bessie', 'Earl', 'Ruth', 'Hank', 'Mabel', 'Jebediah', 'Opal'];
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

/** The invite as a link: opening it lands on the join screen with the code filled in. */
export function inviteLink(code, loc = location) {
  return `${loc.origin}${loc.pathname}#join=${code}`;
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
    this.session = null;
    this.invite = null;
    this.joinLink = null;
    this.$ = (n) => root.querySelector(`[data-mm=${n}]`);
    this.nameEl = this.$('name');
    let saved = '';
    try { saved = localStorage.getItem(NAME_KEY) ?? ''; } catch { /* storage blocked: fine */ }
    this.nameEl.value = saved || `${GOOFY_NAMES[Math.floor(Math.random() * GOOFY_NAMES.length)]}`;
    this.nameEl.addEventListener('change', () => {
      try { localStorage.setItem(NAME_KEY, cleanName(this.nameEl.value)); } catch { /* ignore */ }
    });
    root.addEventListener('click', (e) => {
      const b = e.target.closest?.('button[data-mm]');
      if (b && !b.disabled) this.onClick(b.dataset.mm);
    });
    // Keys typed into the name or code boxes are for the menu, not the game.
    root.addEventListener('keydown', (e) => e.stopPropagation());
    if (!navigator.share) for (const n of ['shareInvite', 'shareReply']) this.$(n).hidden = true;
  }

  get name() { return cleanName(this.nameEl.value); }

  /** Show the title screen, or the join screen if the page was opened from an invite link. */
  show() {
    this.root.hidden = false;
    const m = /join=([^&]+)/.exec(location.hash);
    if (m) {
      history.replaceState(null, '', location.pathname + location.search); // a reload shouldn't rejoin
      this.showJoin(decodeURIComponent(m[1]));
    } else {
      this.screen('home');
    }
  }

  screen(name) {
    for (const s of this.root.querySelectorAll('[data-screen]')) s.hidden = s.dataset.screen !== name;
  }

  onClick(what) {
    switch (what) {
      case 'solo': this.launch({ map: 'field' }); break;
      case 'playground': this.launch({ map: 'playground' }); break;
      case 'host': this.showHost(); break;
      case 'join': this.showJoin(''); break;
      case 'back': this.leave(); break;
      case 'invite': this.newInvite(); break;
      case 'connect': this.connect(); break;
      case 'start': this.startHosted(); break;
      case 'makeReply': this.makeReply(); break;
      case 'copyInvite': this.copy(this.$('inviteOut'), this.$('copyInvite')); break;
      case 'shareInvite': this.share(this.$('inviteOut').value); break;
      case 'copyReply': this.copy(this.$('replyOut'), this.$('copyReply')); break;
      case 'shareReply': this.share(this.$('replyOut').value); break;
    }
  }

  launch(opts) {
    try { localStorage.setItem(NAME_KEY, this.name); } catch { /* ignore */ }
    this.root.hidden = true;
    this.play(opts);
  }

  status(screen, text, tone = '') {
    const el = this.$(screen === 'host' ? 'hostStatus' : 'joinStatus');
    el.textContent = text;
    el.className = `mm-status ${tone}`;
  }

  // ---- hosting ------------------------------------------------------------

  showHost() {
    this.screen('host');
    if (!lanSupported()) { this.status('host', 'This browser has no WebRTC, so it can\'t host.', 'bad'); return; }
    this.session = new HostSession(this.name);
    this.session.onChange = () => this.renderHost();
    this.session.onEvent = (e) => {
      if (e.kind === 'joined') this.status('host', `${e.name} joined the farm!`, 'good');
      if (e.kind === 'left') this.status('host', `${e.name} left.`, 'bad');
    };
    this.renderHost();
    this.newInvite();
  }

  renderHost() {
    const s = this.session;
    const rows = s.players.map((p) =>
      `<li><i style="background:${hex(FARMER_COLORS[p.color])}"></i>${p.name}<small>${p.id === 0 ? 'host (you)' : 'joined'}</small></li>`);
    for (let k = s.players.length; k < MAX_FARMERS; k++) rows.push('<li class="empty"><i></i>empty spot</li>');
    this.$('players').innerHTML = rows.join('');
    this.$('invite').hidden = !!this.invite || s.full;
    this.$('start').textContent = s.players.length > 1 ? `START GAME (${s.players.length} FARMERS)` : 'START GAME';
  }

  async newInvite() {
    const s = this.session;
    if (!s || s.full) return;
    this.invite?.cancel();
    this.invite = null;
    this.$('invite').hidden = true;
    this.status('host', 'Making an invite…');
    try {
      const inv = await createInvite();
      if (this.session !== s) { inv.cancel(); return; } // left the lobby meanwhile
      this.invite = inv;
      this.$('inviteOut').value = inviteLink(inv.code);
      this.$('replyIn').value = '';
      this.$('inviteBox').hidden = false;
      this.status('host', 'Both of you need to be on the same Wi-Fi (or one phone\'s hotspot).');
    } catch (e) {
      this.status('host', e.message, 'bad');
      this.$('invite').hidden = false;
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
      this.status('host', 'Connected! Invite another farmer or START GAME.', 'good');
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

  showJoin(prefill) {
    this.screen('join');
    this.$('inviteIn').value = prefill;
    this.$('inviteInBox').hidden = false;
    this.$('replyBox').hidden = true;
    this.$('joinPlayers').hidden = true;
    this.status('join', lanSupported() ? 'Both of you need to be on the same Wi-Fi (or one phone\'s hotspot).' : 'This browser has no WebRTC, so it can\'t join.', lanSupported() ? '' : 'bad');
    if (prefill && lanSupported()) this.makeReply();
  }

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
    const s = this.session = new JoinSession(this.name, link);
    s.onChange = () => this.renderJoin();
    s.onEvent = (e) => {
      if (e.kind === 'hostLost' && !s.started) this.status('join', 'The host closed the lobby.', 'bad');
      if (e.kind === 'full') this.status('join', `Can't join: ${e.why}.`, 'bad');
    };
    s.onStart = ({ seed, map }) => this.launch({ map, seed, session: s });
    this.$('replyBox').hidden = true;
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

  leave() {
    this.invite?.cancel();
    this.invite = null;
    this.session?.close();
    this.session = null;
    this.joinLink?.close();
    this.joinLink = null;
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
    const was = button.dataset.label ?? (button.dataset.label = button.textContent);
    button.textContent = ok ? 'COPIED!' : 'SELECT + COPY';
    setTimeout(() => { button.textContent = was; }, 1500);
  }

  share(text) {
    if (text) navigator.share?.({ title: 'CowTD co-op', text }).catch(() => {});
  }
}

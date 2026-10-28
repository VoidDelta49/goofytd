// Pause menu: a DOM overlay of big, labelled buttons (works with mouse and touch).
// Holds everything that used to be a row of cryptic corner buttons: sound,
// auto-hop, look speed, fullscreen, respawn, restart. It owns no game state:
// main.js passes the actions in and a function that reports the current values.

/** How long the first RESTART tap waits for a confirming second tap (ms). */
export const RESTART_CONFIRM_MS = 3000;

export class PauseMenu {
  /**
   * @param {HTMLElement} root the #pause overlay
   * @param {Record<string, (e: Event) => void>} actions keyed by data-menu name:
   *   resume, sound, autoHop, sensDown, sensUp, fullscreen, respawn, restart
   * @param {() => {muted: boolean, autoHop: boolean, sens: string}} getState
   */
  constructor(root, actions, getState) {
    this.root = root;
    this.actions = actions;
    this.getState = getState;
    this.restartArmedUntil = 0;
    this.el = (name) => root.querySelector(`[data-menu=${name}]`);
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get open() { return !this.root.hidden; }

  show() {
    this.restartArmedUntil = 0;
    this.root.hidden = false;
    this.refresh();
  }

  hide() {
    this.root.hidden = true;
  }

  onClick(e) {
    const btn = e.target.closest?.('button[data-menu]');
    if (!btn) return;
    const name = btn.dataset.menu;
    if (name === 'restart') {
      // Wiping a run by accident on a phone is easy: ask twice.
      const now = performance.now();
      if (now > this.restartArmedUntil) {
        this.restartArmedUntil = now + RESTART_CONFIRM_MS;
        this.refresh();
        setTimeout(() => { if (this.open) this.refresh(); }, RESTART_CONFIRM_MS + 50);
        return;
      }
      this.restartArmedUntil = 0;
    }
    this.actions[name]?.(e);
    if (this.open) this.refresh();
  }

  /** Rewrite the labels that show a current value. */
  refresh() {
    const s = this.getState();
    this.el('sound').textContent = s.muted ? 'SOUND: OFF' : 'SOUND: ON';
    this.el('autoHop').textContent = s.autoHop ? 'AUTO-HOP: ON' : 'AUTO-HOP: OFF';
    this.el('sensLabel').textContent = `LOOK SPEED ${s.sens}`;
    const armed = performance.now() < this.restartArmedUntil;
    this.el('restart').textContent = armed ? 'TAP AGAIN TO RESTART' : 'RESTART GAME';
    this.el('restart').classList.toggle('armed', armed);
  }
}

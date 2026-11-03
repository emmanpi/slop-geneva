// The city's clock: seconds since midnight, running in real time from the hour of the chosen light (the timetables of
// js/transit.js and js/trams.js follow it). ?heure=HH:MM in the URL sets it.

export const PRESET_HOURS = { golden: 16.75, midday: 12.5, twilight: 17.75, midnight: 23 };

export const simClock = {
  seconds: PRESET_HOURS.golden * 3600,
  rate: 1,
  fixed: false, // set from the URL: the light presets leave it alone
  tick(dt) { this.seconds = (this.seconds + dt * this.rate) % 86400; },
  setHour(h) { if (!this.fixed) this.seconds = (h * 3600) % 86400; },
  label() {
    const s = Math.floor(this.seconds);
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;
  }
};

if (typeof location !== 'undefined') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(new URLSearchParams(location.search).get('heure') || '');
  if (m) { simClock.seconds = (+m[1] * 3600 + +m[2] * 60) % 86400; simClock.fixed = true; }
}

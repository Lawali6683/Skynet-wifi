import { LocalDB } from './db.js';
import { SkyNetMirrorSync } from './mirror.js';

const events = new EventTarget();
let timer = null;
let counterReader = null;
let previousTx = null;
let previousRx = null;

function remainingDays(profile) {
  const raw = profile.plan2_remaining_days ?? profile.plan2_days;
  if (raw === undefined || raw === null || raw === '') return null;
  const days = parseInt(raw, 10);
  return Number.isNaN(days) ? null : days;
}

function emit(name, detail) {
  events.dispatchEvent(new CustomEvent(name, { detail }));
}

async function tick() {
  const profile = LocalDB.getProfile();
  if (!Object.keys(profile).length) return;

  if (profile.plan2_active === 'yes') {
    const days = remainingDays(profile);
    if (days !== null && days <= 0) {
      profile.plan2_active = 'no';
      profile.login_status = 'no';
      profile.online_status = 'off';
      LocalDB.setProfile(profile);
      emit('cutoff_triggered', { reason: 'Subscription Period Expired' });
      return;
    }
  }

  if (typeof counterReader !== 'function') return;

  let counters = null;
  try {
    counters = await counterReader();
  } catch (_) {
    return;
  }
  if (!counters || typeof counters.tx !== 'number' || typeof counters.rx !== 'number') return;

  if (previousTx === null || previousRx === null) {
    previousTx = counters.tx;
    previousRx = counters.rx;
    return;
  }

  const deltaTx = Math.max(0, counters.tx - previousTx);
  const deltaRx = Math.max(0, counters.rx - previousRx);
  previousTx = counters.tx;
  previousRx = counters.rx;

  const consumedBytes = deltaTx + deltaRx;
  if (consumedBytes <= 0) return;

  let dataBalanceMB = parseFloat(profile.data_balance ?? '0') || 0;
  dataBalanceMB -= consumedBytes / (1024 * 1024);

  if (dataBalanceMB <= 0) {
    profile.plan1_active = 'no';
    profile.plan2_active = 'no';
    profile.online_status = 'off';
    profile.data_balance = 0.0;
    LocalDB.setProfile(profile);
    emit('data_exhausted_exception', { message: 'Data limit reached. Drop back to Walled Garden.' });
    return;
  }

  profile.data_balance = dataBalanceMB;
  LocalDB.setProfile(profile);
  await SkyNetMirrorSync.accumulateAndCheckSync(consumedBytes);
}

export const SkyNetMeterEngine = {
  setCounterReader(reader) {
    counterReader = reader;
    previousTx = null;
    previousRx = null;
  },
  on(name, handler) {
    events.addEventListener(name, (e) => handler(e.detail));
  },
  start() {
    if (timer) return;
    timer = setInterval(() => {
      if (!document.hidden) tick();
    }, 1000);
  },
  stop() {
    clearInterval(timer);
    timer = null;
  }
};
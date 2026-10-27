export const API_BASE = 'https://skynetwifi.pages.dev/api/';
export const CHANGE_DEVICE_URL = 'https://skynetwifi.pages.dev/chenge';

const PREFIX = 'skynet_';

export const store = {
  get(key, fallback = false) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (_) {}
  },
  remove(key) {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch (_) {}
  }
};
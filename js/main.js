import { store } from './config.js';
import { SkyNetLoader } from './loader.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

const target = !store.get('is_setup_done', false)
  ? 'perm.html'
  : store.get('is_logged_in', false)
    ? 'dash.html'
    : 'login.html';

SkyNetLoader.show();
setTimeout(() => location.replace(target), 700);
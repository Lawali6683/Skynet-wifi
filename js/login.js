import { supabase } from './supabase.js';
import { store, CHANGE_DEVICE_URL } from './config.js';
import { SkyNetLoader, showAlert } from './loader.js';

const $ = (id) => document.getElementById(id);
const form = $('form');
const emailInput = $('email');
const passInput = $('password');
const denied = $('denied');
const eye = $('eye');

const EYE_ON = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.2A9.6 9.6 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.5 7.6C3.7 9.4 2 12 2 12s3.6 6 10 6c1.5 0 2.8-.3 4-.8"/></svg>';

let busy = false;

eye.innerHTML = EYE_OFF;
eye.addEventListener('click', () => {
  const hidden = passInput.type === 'password';
  passInput.type = hidden ? 'text' : 'password';
  eye.innerHTML = hidden ? EYE_ON : EYE_OFF;
});

[emailInput, passInput].forEach((input) => {
  input.addEventListener('input', () => input.closest('.field').classList.remove('invalid'));
});

function fail(message, field) {
  showAlert(message, false);
  field.classList.remove('invalid');
  void field.offsetWidth;
  field.classList.add('invalid');
  return false;
}

function validate() {
  const email = emailInput.value.trim();
  if (!email) return fail('Email required', $('f-email'));
  if (!email.includes('@')) return fail('Invalid email configuration syntax', $('f-email'));
  if (!passInput.value) return fail('Security password signature missing', $('f-password'));
  return true;
}

async function handleLogin() {
  if (busy || !validate()) return;

  busy = true;
  denied.classList.add('hidden');
  SkyNetLoader.show('Running Security Diagnostics...');

  try {
    const { data: auth, error: authError } = await supabase.auth.signInWithPassword({
      email: emailInput.value.trim(),
      password: passInput.value
    });
    if (authError) throw authError;

    if (!auth || !auth.user) {
      SkyNetLoader.hide();
      showAlert('Authentication terminated. Invalid server response.', false);
      return;
    }

    const { data: verdict, error: deviceError } = await supabase.rpc('check_device');
    if (deviceError || verdict === 'error') {
      await supabase.auth.signOut();
      SkyNetLoader.hide();
      showAlert('Could not verify this device. Please try again.', false);
      return;
    }

    if (verdict === 'ok') {
      showAlert('Authentication verified successfully!', true);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      store.set('is_setup_done', true);
      store.set('is_logged_in', true);
      location.replace('index.html');
      return;
    }

    await supabase.auth.signOut();
    SkyNetLoader.hide();
    denied.classList.remove('hidden');
    showAlert('Security Exception: Unauthorized device signature detected.', false);
  } catch (err) {
    SkyNetLoader.hide();
    showAlert('Authentication Error: ' + ((err && err.message) || 'Network error'), false);
  } finally {
    busy = false;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  handleLogin();
});

$('change-device').addEventListener('click', () => {
  window.open(CHANGE_DEVICE_URL, '_blank', 'noopener');
});
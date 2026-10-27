import { supabase } from './supabase.js';
import { icon } from './icons.js';
import { showAlert } from './loader.js';

export async function verifyPin(pin) {
  const { data, error } = await supabase.rpc('verify_pin', { p_pin: pin });
  if (error) {
    const locked = /PIN_LOCKED/.test(error.message || '');
    const err = new Error(locked ? 'PIN locked after too many wrong attempts. Try again in 15 minutes.' : 'Could not verify PIN. Check your connection.');
    err.locked = locked;
    throw err;
  }
  return data === true;
}

export function mountPinRow(row, onChange) {
  row.innerHTML = '';
  const inputs = [];
  const cells = [];
  let verified = false;
  let checking = false;

  function paint(state) {
    cells.forEach((cell) => {
      cell.className = 'pin-cell' + (state ? ' ' + state : '');
      cell.querySelector('.stt').innerHTML = state === 'valid' ? icon('check', 14) : state === 'invalid' ? icon('x', 14) : '';
    });
  }

  function value() {
    return inputs.map((i) => i.value).join('');
  }

  function reset() {
    inputs.forEach((i) => { i.value = ''; });
    verified = false;
    paint(null);
    onChange(false);
  }

  async function evaluate() {
    const pin = value();
    verified = false;
    if (pin.length < 4) {
      paint(null);
      onChange(false);
      return;
    }
    if (checking) return;
    checking = true;
    try {
      verified = await verifyPin(pin);
      paint(verified ? 'valid' : 'invalid');
      if (!verified) setTimeout(reset, 800);
    } catch (err) {
      paint('invalid');
      showAlert(err.message, false);
      setTimeout(reset, 800);
    } finally {
      checking = false;
      onChange(verified);
    }
  }

  for (let i = 0; i < 4; i++) {
    const cell = document.createElement('div');
    cell.className = 'pin-cell';
    cell.innerHTML = '<span class="stt"></span><input type="password" inputmode="numeric" maxlength="1" autocomplete="off" aria-label="PIN ' + (i + 1) + '">';
    const input = cell.querySelector('input');
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 1);
      if (input.value && i < 3) inputs[i + 1].focus();
      evaluate();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && i > 0) inputs[i - 1].focus();
    });
    inputs.push(input);
    cells.push(cell);
    row.appendChild(cell);
  }

  return {
    get verified() {
      return verified;
    },
    value,
    reset
  };
}
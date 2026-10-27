import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const supabaseUrl = 'https://canvzqvhrvyyanoicmgf.supabase.co';
const supabaseKey = 'sb_publishable_gKdgmKqcZBCdPVftHbdpxg_TVhvJuWj';

export const supabase = createClient(supabaseUrl, supabaseKey);

export async function authHeaders() {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data && data.session ? data.session.access_token : null;
    return token ? { Authorization: 'Bearer ' + token } : {};
  } catch (_) {
    return {};
  }
}
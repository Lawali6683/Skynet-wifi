import { LocalDB } from './db.js';
import { API_BASE, store } from './config.js';
import { authHeaders } from './supabase.js';

const SYNC_THRESHOLD_BYTES = 52428800;
let syncing = false;

export const SkyNetMirrorSync = {
  syncThresholdBytes: SYNC_THRESHOLD_BYTES,

  async accumulateAndCheckSync(bytesConsumed) {
    const delta = (parseInt(store.get('consumed_delta', 0), 10) || 0) + bytesConsumed;
    if (delta >= SYNC_THRESHOLD_BYTES) {
      await this.executeServerSync(delta);
    } else {
      store.set('consumed_delta', delta);
    }
  },

  async executeServerSync(deltaBytes) {
    if (syncing) {
      store.set('consumed_delta', deltaBytes);
      return;
    }
    syncing = true;
    const profile = LocalDB.getProfile();

    try {
      const response = await fetch(API_BASE + 'mirror', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({
          id: profile.id || '',
          consumed_delta: deltaBytes
        })
      });

      if (response.status === 200) {
        store.set('consumed_delta', 0);
      } else if (response.status === 400 || response.status === 401 || response.status === 404) {
        profile.plan1_active = 'no';
        profile.plan2_active = 'no';
        profile.data_balance = 0.0;
        profile.online_status = 'off';
        LocalDB.setProfile(profile);
        store.set('consumed_delta', 0);
      } else {
        store.set('consumed_delta', deltaBytes);
      }
    } catch (_) {
      store.set('consumed_delta', deltaBytes);
    } finally {
      syncing = false;
    }
  }
};
import { store } from './config.js';
import { supabase } from './supabase.js';

function createNotifier(initial) {
  let current = initial;
  const subscribers = new Set();
  return {
    get value() {
      return current;
    },
    set value(next) {
      current = next;
      subscribers.forEach((fn) => fn(next));
    },
    subscribe(fn) {
      subscribers.add(fn);
      fn(current);
      return () => subscribers.delete(fn);
    }
  };
}

async function currentUserId() {
  const { data } = await supabase.auth.getSession();
  return data && data.session ? data.session.user.id : null;
}

export const LocalDB = {
  userProfileNotifier: createNotifier({}),
  pricingPlansNotifier: createNotifier({}),
  wifiPurchasesNotifier: createNotifier([]),
  dataSaleNotifier: createNotifier([]),
  adDataNotifier: createNotifier([]),
  freeDataNotifier: createNotifier({}),

  initialize() {
    if (store.get('free_data_ip', null) === null) store.set('free_data_ip', '52-skyNetwifi');

    this.userProfileNotifier.value = store.get('profile_data', {});
    this.pricingPlansNotifier.value = store.get('plans_data', {});
    this.wifiPurchasesNotifier.value = store.get('purchases_data', []);
    this.dataSaleNotifier.value = store.get('sales_data', []);
    this.adDataNotifier.value = this.getAds();
    this.freeDataNotifier.value = { free_data_ip: store.get('free_data_ip', '') };
  },

  getProfile() {
    const profile = store.get('profile_data', {});
    return profile && typeof profile === 'object' ? { ...profile } : {};
  },

  setProfile(profile) {
    store.set('profile_data', profile);
    this.userProfileNotifier.value = profile;
  },

  getUserField(key) {
    return this.getProfile()[key];
  },

  getAds() {
    const ads = store.get('ad_data', {});
    return Object.values(ads || {});
  },

  async syncProfile() {
    try {
      const userId = await currentUserId();
      if (!userId) return false;
      const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
      if (error || !data) return false;
      this.setProfile({ ...this.getProfile(), ...data });
      return true;
    } catch (_) {
      return false;
    }
  },

  async syncPlans() {
    try {
      const { data, error } = await supabase.from('pricing_plans').select('*').eq('active', true).order('sort');
      if (error || !data) return false;
      const map = {};
      data.forEach((r) => {
        map[r.id] = { name: r.name, cost: Number(r.cost), speed: r.speed, duration: r.duration, limits: r.limits, kind: r.kind, data_mb: r.data_mb, days: r.days };
      });
      store.set('plans_data', map);
      this.pricingPlansNotifier.value = map;
      return true;
    } catch (_) {
      return false;
    }
  },

  async syncAds() {
    try {
      const { data, error } = await supabase.from('ads').select('id, ad_image, ad_link').eq('active', true).order('created_at', { ascending: false }).limit(5);
      if (error || !data) return false;
      this.rotateAdvertisingCache(data.map((a) => ({ id: a.id, Ad_image: a.ad_image, Ad_link: a.ad_link })));
      return true;
    } catch (_) {
      return false;
    }
  },

  async updateBalanceOptimistic({ amount, isCredit }) {
    const profile = this.getProfile();
    const previousBalance = parseFloat(profile.balance ?? '0') || 0;
    const newBalance = isCredit ? previousBalance + amount : previousBalance - amount;
    const notifications = Array.isArray(profile.account_notifications) ? [...profile.account_notifications] : [];

    notifications.push({
      message: isCredit
        ? 'You get ' + amount + ' in your SkyNet WiFi account total ' + newBalance
        : 'You send ' + amount + ' in your SkyNet WiFi account remain ' + newBalance,
      unread: true
    });

    profile.balance = newBalance;
    profile.account_notifications = notifications;
    this.setProfile(profile);

    try {
      const userId = await currentUserId();
      if (!userId) throw new Error('no user');
      const { error } = await supabase
        .from('profiles')
        .update({ balance: newBalance, account_notifications: notifications })
        .eq('id', userId);
      if (error) throw error;
      return true;
    } catch (_) {
      const rollback = this.getProfile();
      rollback.balance = previousBalance;
      rollback.account_notifications = notifications.slice(0, -1);
      this.setProfile(rollback);
      return false;
    }
  },

  async updateDataBalanceOptimistic({ dataAmount, isCredit }) {
    const profile = this.getProfile();
    const previous = parseFloat(profile.data_balance ?? '0') || 0;
    const next = isCredit ? previous + dataAmount : previous - dataAmount;

    profile.data_balance = next;
    this.setProfile(profile);

    try {
      const userId = await currentUserId();
      if (!userId) throw new Error('no user');
      const { error } = await supabase.from('profiles').update({ data_balance: next }).eq('id', userId);
      if (error) throw error;
      return true;
    } catch (_) {
      const rollback = this.getProfile();
      rollback.data_balance = previous;
      this.setProfile(rollback);
      return false;
    }
  },

  rotateAdvertisingCache(remoteAds) {
    const cached = store.get('ad_data', {}) || {};
    const localKeys = new Set(Object.keys(cached));
    const holdsNewAd = remoteAds.some((ad) => !localKeys.has(String((ad && ad.id) ?? '')));
    if (!holdsNewAd) return;

    const fresh = {};
    remoteAds.forEach((ad) => {
      fresh[String((ad && ad.id) ?? '')] = ad;
    });
    store.set('ad_data', fresh);
    this.adDataNotifier.value = remoteAds;
  }
};

LocalDB.initialize();
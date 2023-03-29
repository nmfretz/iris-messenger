import { RelayPool } from 'nostr-relaypool';

import { Event, Filter, matchFilter } from '../lib/nostr-tools';
import localState from '../LocalState';
import Events from '../nostr/Events';

import IndexedDB from './IndexedDB';
import Relays from './Relays';

type Subscription = {
  filter: Filter;
  callback?: (event: Event) => void;
};

type Unsubscribe = () => void;

let subscriptionId = 0;

let dev: any = {
  logSubscriptions: false,
  indexed03: false,
  useRelayPool: false,
};
const relayPool = new RelayPool(Relays.DEFAULT_RELAYS, {
  useEventCache: false,

  externalGetEventById: (id) => Events.db.by('id', id),
});
localState.get('dev').on((d) => {
  dev = d;
  relayPool.logSubscriptions = dev.logSubscriptions;
});

let lastOpened = 0;
localState.get('lastOpened').once((lo) => {
  lastOpened = lo;
  localState.get('lastOpened').put(Math.floor(Date.now() / 1000));
});

/**
 * Iris (mostly) internal Subscriptions. Juggle between LokiJS (memory), IndexedDB, http proxy and Relays.
 *
 * TODO:
 * 1) Only subscribe to what is needed for current view, unsubscribe on unmount
 * 2) Ask memory cache first, then dexie, then http proxy, then relays
 */
const PubSub = {
  subscriptions: new Map<number, Subscription>(),
  subscribedEventIds: new Set<string>(),
  subscribedAuthors: new Set<string>(), // all events by authors
  /**
   * Internal subscription. First looks up in memory, then in IndexedDB, then in http proxy, then in relays.
   * @param filters
   * @param cb
   * @param name optional name for the subscription. replaces the previous one with the same name
   * @returns unsubscribe function
   */
  subscribe: function (
    filter: Filter,
    cb?: (event: Event) => void,
    sinceLastOpened = true,
  ): Unsubscribe {
    let currentSubscriptionId;
    if (cb) {
      currentSubscriptionId = subscriptionId++;
      this.subscriptions.set(++subscriptionId, {
        filter,
        cb,
      });
    }

    cb && Events.find(filter, cb);
    IndexedDB.subscribe(filter); // calls Events.handle which calls subscriptions with matching filters

    // TODO if asking event by id or profile, ask http proxy

    let unsubRelays;
    if (dev.useRelayPool) {
      // TODO relaypool should use only search relays if filters.keywords is defined
      unsubRelays = this.subscribeRelayPool(filter, sinceLastOpened);
    } else {
      unsubRelays = Relays.subscribe(filter, sinceLastOpened);
    }

    return () => {
      unsubRelays();
      if (currentSubscriptionId) {
        this.subscriptions.delete(currentSubscriptionId);
      }
    };
  },

  handle(event: Event & { id: string }) {
    // go through subscriptions and callback if filters match
    for (const sub of PubSub.subscriptions.values()) {
      if (!sub.filter) {
        continue;
      }
      if (matchFilter(sub.filter, event)) {
        sub.callback && sub.callback(event);
      }
    }
  },

  subscribeRelayPool(filters: Filter[], sinceLastOpened: boolean) {
    let relays: any = undefined;
    // if any of filters[] doesn't have authors, we need to define default relays
    if (filters.some((f) => !f.authors)) {
      relays = Relays.DEFAULT_RELAYS;
    }
    if (
      dev.indexed03 &&
      filters.every((f) => f.kinds && f.kinds.every((k) => k === 0 || k === 3))
    ) {
      relays = ['wss://us.rbr.bio', 'wss://eu.rbr.bio'];
    }
    if (sinceLastOpened) {
      filters.forEach((f) => {
        f.since = lastOpened;
      });
    }
    return relayPool.subscribe(
      filters,
      relays,
      (event) => {
        Events.handle(event);
      },
      100,
    );
  },
};

export default PubSub;
export { Unsubscribe };

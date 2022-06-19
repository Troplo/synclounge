import promiseutils from '@/utils/promiseutils';
import { fetchJson, queryFetch } from '@/utils/fetchutils';
import { difference } from '@/utils/lightlodash';
import { slPlayerClientId } from '@/player/constants';

export default {
  FETCH_PLEX_INIT_AUTH: async ({ getters }, signal) => fetchJson(
    'https://plex.troplo.com/api/v2/pins',
    { strong: true },
    {
      method: 'POST',
      headers: getters.GET_PLEX_INITIAL_AUTH_PARAMS,
      signal,
    },
  ),

  REQUEST_PLEX_AUTH_TOKEN: async ({ getters, commit, dispatch }, { signal, id }) => {
    const data = await fetchJson(
      `https://plex.troplo.com/api/v2/pins/${id}`,
      null,
      {
        headers: getters.GET_PLEX_INITIAL_AUTH_PARAMS,
        signal,
      },
    );

    if (!data.authToken) {
      throw new Error("Plex didn't give authToken");
    }

    commit('SET_PLEX_AUTH_TOKEN', data.authToken);

    await dispatch('FETCH_PLEX_USER', signal);
  },

  FETCH_PLEX_USER: async ({ getters, commit }, signal) => {
    const data = await fetchJson('https://plex.troplo.com/api/v2/user', {
      ...getters.GET_PLEX_BASE_PARAMS(),
      includeSubscriptions: 1,
      includeProviders: 1,
      includeSettings: 1,
      includeSharedSettings: 1,
    }, { signal });

    commit('SET_PLEX_USER', data);
  },

  // Private function, please use FETCH_PLEX_DEVICES instead
  _FETCH_PLEX_DEVICES: async ({
    state: { areDevicesCached }, commit, dispatch, getters, rootGetters,
  }) => {
    // Store old list of server/client ids, to be able to take difference after the update and
    // find devices that weren't updated and remove them
    const oldClientIds = rootGetters['plexclients/GET_PLEX_CLIENT_IDS']
      .filter((clientId) => clientId !== slPlayerClientId);
    const oldServersIds = rootGetters['plexservers/GET_PLEX_SERVER_IDS'];

    const devices = await fetchJson('https://plex.troplo.com/api/v2/resources', {
      ...getters.GET_PLEX_BASE_PARAMS(),
      includeHttps: 1,
      includeRelay: 1,
    });

    await Promise.allSettled(devices.map(async (device) => {
      if (device.provides.indexOf('player') !== -1) {
        // This is a Client
        commit('plexclients/ADD_PLEX_CLIENT', device, { root: true });
      } else if (device.provides.indexOf('server') !== -1) {
        // This is a Server
        // TODO: potentially find connections async and not hold up the fetch devices
        try {
          const chosenConnection = await dispatch('FIND_WORKING_CONNECTION_PREFERRED', {
            name: device.name,
            connections: device.connections,
            accessToken: device.accessToken,
          });

          const libraries = await dispatch('plexservers/FETCH_ALL_LIBRARIES', {
            machineIdentifier: device.clientIdentifier,
            manualConnection: {
              chosenConnection,
              accessToken: device.accessToken,
            },
          }, { root: true });

          commit('plexservers/ADD_PLEX_SERVER', {
            ...device,
            libraries,
            chosenConnection,
          }, { root: true });
        } catch (e) {
          const text = `Unable to find working connection to plex server: ${device.name}`;
          await dispatch('DISPLAY_NOTIFICATION', {
            text,
            color: 'error',
          }, { root: true });
          console.error(text, e);
        }
      }
    }));

    // Find devices that weren't updated
    const staleClientIds = difference([
      oldClientIds,
      rootGetters['plexclients/GET_PLEX_CLIENT_IDS'],
    ]);

    staleClientIds.forEach((clientId) => {
      commit('plexclients/DELETE_PLEX_CLIENT', clientId, { root: true });
    });

    const staleServerIds = difference([
      oldServersIds,
      rootGetters['plexservers/GET_PLEX_SERVER_IDS'],
    ]);

    staleServerIds.forEach((serverId) => {
      commit('plexservers/DELETE_PLEX_SERVER', serverId, { root: true });
    });

    commit('plexclients/UPDATE_SLPLAYER_LAST_SEEN_TO_NOW', null, { root: true });

    if (!areDevicesCached) {
      commit('SET_ARE_DEVICES_CACHED', true);
    }
  },

  FETCH_PLEX_DEVICES: async ({ getters, commit, dispatch }) => {
    // If we already have started checking for devices,
    // wait for that to finish instead of starting new request
    if (!getters.GET_DEVICE_FETCH_PROMISE) {
      const fetchPromise = dispatch('_FETCH_PLEX_DEVICES');
      commit('SET_DEVICE_FETCH_PROMISE', fetchPromise);
    }

    await getters.GET_DEVICE_FETCH_PROMISE;
    commit('SET_DEVICE_FETCH_PROMISE', null);
  },

  // Use this to trigger a fetch if you don't need the devices refreshed
  FETCH_PLEX_DEVICES_IF_NEEDED: async ({ state: { areDevicesCached }, getters, dispatch }) => {
    if (!areDevicesCached && getters.GET_DEVICE_FETCH_PROMISE == null) {
      await dispatch('FETCH_PLEX_DEVICES');
    }

    await getters.GET_DEVICE_FETCH_PROMISE;
  },

  TEST_PLEX_CONNECTION: async ({ getters }, { connection, accessToken, signal }) => {
    await queryFetch(
      connection.uri,
      getters.GET_PLEX_BASE_PARAMS(accessToken),
      { signal },
    );

    return connection;
  },

  FIND_WORKING_CONNECTION: async ({ dispatch }, { connections, accessToken }) => {
    const controller = new AbortController();
    const workingConnection = await promiseutils.any(
      connections.map((connection) => dispatch(
        'TEST_PLEX_CONNECTION',
        { connection, accessToken, signal: controller.signal },
      )),
    );

    // Abort other connection attempts since we found one
    controller.abort();

    return workingConnection;
  },

  // This function iterates through all available connections and
  // if any of them return a valid response we'll set that connection
  // as the chosen connection for future use.
  FIND_WORKING_CONNECTION_PREFERRED: async ({ dispatch }, { name, connections, accessToken }) => {
    console.debug('FIND_WORKING_CONNECTION_PREFERRED', name);

    const nonRelayConnections = connections.filter((connection) => !connection.relay);
    // Prefer secure connections first.
    const secureConnections = nonRelayConnections.filter((connection) => connection.protocol
      === 'https');

    try {
      const conn = await dispatch('FIND_WORKING_CONNECTION', {
        connections: secureConnections,
        accessToken,
      });
      console.log(name, 'using secure connection', conn);
      return conn;
    } catch (e) {
      console.warn(name, 'no working secure connections found');
    }

    // If we are using synclounge over https, we can't access connections over http because
    // most modern web browsers block mixed content
    const insecureConnections = nonRelayConnections.filter((connection) => connection.protocol
      === 'http');
    try {
      const conn = await dispatch('FIND_WORKING_CONNECTION', {
        connections: insecureConnections,
        accessToken,
      });
      console.log(name, 'using insecure connection', conn);
      return conn;
    } catch (e) {
      console.warn(name, 'no working insecure connections found');
    }

    // Finally try relay connections if we failed everywhere else.
    const relayConnections = connections.filter((connection) => connection.relay);
    try {
      const relayConnection = await dispatch('FIND_WORKING_CONNECTION', {
        connections: relayConnections,
        accessToken,
      });
      console.log(name, 'using relay connection', name);
      return relayConnection;
    } catch (e) {
      console.error(name, 'no working connections found', connections);
      throw e;
    }
  },
};

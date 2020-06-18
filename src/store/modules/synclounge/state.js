import guid from '@/utils/guid';

const state = () => ({
  uuid: guid(),
  socket: null,
  server: null,
  room: null,
  password: false,
  users: [],
  messages: [],
  partyPausing: false,
  decisionBlockedTime: 0,
  hostTimeline: null,
  rawTitle: null,
  serversHealth: null,

  // This is used to calculate RTT between us and synclounge server
  // It is a map between poll number and time sent
  unackedPolls: {},
  pollNumber: 0,

  // Smoothed round trip time
  srtt: null,
});

export default state;

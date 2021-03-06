
import { ElectrumTransport } from 'electrum-cash'

// Electrum constants
export const electrumServers = [
  // Our mainnet server, we need to setup a testnet server as well.
  {
    url: 'tfulcrum.cashweb.io',
    port: 443,
    scheme: ElectrumTransport.WSS.Scheme
  }
  // {
  //   url: 'electrum.bitcoinabc.org',
  //   port: 50004,
  //   scheme: 'wss'
  // },
  // {
  //   url: 'bchabc.fmarcosh.xyz',
  //   port: 50003,
  //   scheme: ElectrumTransport.WS.Scheme
  // },
  // {
  //   url: 'telectrum.bitcoinabc.org',
  //   port: 60006,
  //   scheme: ElectrumTransport.WS.Scheme
  // },
  // {
  //   url: 'tfulcrum.cashweb.io',
  //   port: 443,
  //   scheme: ElectrumTransport.WSS.Scheme
  // }
]

// The separation here is due the fork. Not all backends support the new network prefixes yet
// So we are using the legacy prefixes everywhere for API calls, but using
// the ecash prefix for display
export const networkName = 'testnet'
export const displayNetwork = 'lotus-testnet'

export const electrumPingInterval = 10_000

// Wallet constants
export const numAddresses = 10
export const numChangeAddresses = 10
export const recomendedBalance = 500_000
export const nUtxoGoal = 10
export const feeUpdateTimerMilliseconds = 60_000
export const defaultFeePerByte = 2

// Keyserver constants
export const keyservers = ['https://keyserver.cashweb.io']

// Relay constants
export const pingTimeout = 20_000
export const relayReconnectInterval = 10_000
export const defaultAcceptancePrice = 100
export const defaultRelayUrl = 'https://relay.cashweb.io'
export const relayUrlOptions = ['https://relay.cashweb.io']
export const defaultRelayData = {
  profile: {
    name: '',
    bio: null,
    avatar: null,
    pubKey: null
  },
  inbox: {
    acceptancePrice: defaultAcceptancePrice
  },
  notify: true
}
export const pendingRelayData = {
  profile: {
    name: 'Loading...',
    bio: null,
    avatar: null,
    pubKey: null
  },
  inbox: {
    acceptancePrice: NaN
  },
  notify: true
}

// Avatar constants
export const defaultAvatars = ['bunny_cyborg.png', 'croc_music.png', 'kitty_standard.png', 'panda_ninja.png', 'dog_posh.png']

// Chat constants
export const defaultStampAmount = 5000
export const stampLowerLimit = 1000

export const defaultContacts = [
  {
    name: 'LotusBot',
    address: 'tlotus:qqegajxrzx9juvg9fuu4cqvndz3u2yz6eg8kp2sx8k'
  },
  {
    name: 'President Chancellor',
    address: 'tlotus:qq34halvkdfwqnqkavangm39lj034yrkevv04qnrta'
  },
  {
    name: 'Tobias Ruck',
    address: 'tlotus:qp8edml4zc8yspk4k2u07w6ytf7jt250v5l204d5au'
  }
]

// Notification constants
export const notificationTimeout = 4000

// Contact defaults
export const defaultUpdateInterval = 60 * 10 * 1_000

// Formatting constants
// TODO: Generate this
export const colorSalt = Buffer.from('salt')

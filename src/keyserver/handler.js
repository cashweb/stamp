import axios from 'axios'
import keyserver from './keyserver_pb'
import { AuthWrapper } from '../auth_wrapper/wrapper_pb'
import pop from '../pop'
import { trustedKeyservers } from '../utils/constants'

const cashlib = require('bitcore-lib-cash')

class KeyserverHandler {
  constructor (defaultSampleSize, keyservers) {
    this.keyservers = keyservers || trustedKeyservers
    this.defaultSampleSize = defaultSampleSize || 3
  }

  static constructRelayUrlMetadata (relayUrl, privKey) {
    const relayUrlEntry = new keyserver.Entry()
    relayUrlEntry.setKind('relay-server')
    const rawRelayUrl = new TextEncoder().encode(relayUrl)
    relayUrlEntry.setEntryData(rawRelayUrl)

    // Construct payload
    const payload = new keyserver.Payload()
    payload.setTimestamp(Math.floor(Date.now() / 1000))
    payload.setTtl(31556952) // 1 year
    payload.addEntries(relayUrlEntry)

    const serializedPayload = payload.serializeBinary()
    const hashbuf = cashlib.crypto.Hash.sha256(serializedPayload)
    const ecdsa = cashlib.crypto.ECDSA({ privkey: privKey, hashbuf })
    ecdsa.sign()

    const authWrapper = new AuthWrapper()
    const sig = ecdsa.sig.toCompact(1).slice(1)
    authWrapper.setPubKey(privKey.toPublicKey().toBuffer())
    authWrapper.setSignature(sig)
    authWrapper.setScheme(1)
    authWrapper.setPayload(serializedPayload)

    return authWrapper
  }

  static async fetchMetadata (keyserver, addr) {
    const url = `${keyserver}/keys/${addr}`
    const response = await axios(
      {
        method: 'get',
        url: url,
        responseType: 'arraybuffer'
      }
    )
    if (response.status === 200) {
      const metadata = AuthWrapper.deserializeBinary(response.data)
      return metadata
    }
  }

  chooseServer () {
    // TODO: Sample correctly
    return this.keyservers[0]
  }

  static async paymentRequest (serverUrl, addr, truncatedAuthWrapper) {
    const rawAuthWrapper = truncatedAuthWrapper.serializeBinary()
    const url = `${serverUrl}/keys/${addr.toLegacyAddress()}`
    return await pop.getPaymentRequest(url, 'put', rawAuthWrapper)
  }

  async uniformSample (addr) {
    // TODO: Sample correctly
    const server = this.chooseServer()
    return KeyserverHandler.fetchMetadata(server, addr)
  }

  async getRelayUrl (addr) {
    // Get metadata
    const metadata = await this.uniformSample(addr)
    const payload = keyserver.Payload.deserializeBinary(metadata.getSerializedPayload())

    // Find vCard
    function isRelay (entry) {
      return entry.getKind() === 'relay-server'
    }
    const entryList = payload.getEntriesList()
    const entry = entryList.find(isRelay)
    if (!entry) {
      return null
    }
    const entryData = entry.getEntryData()
    const relayUrl = new TextDecoder().decode(entryData)
    return relayUrl
  }

  static async putMetadata (addr, server, metadata, token) {
    const rawMetadata = metadata.serializeBinary()
    const url = `${server}/keys/${addr.toLegacyAddress()}`
    await axios({
      method: 'put',
      url: url,
      headers: {
        Authorization: token
      },
      data: rawMetadata
    })
  }
}

export default KeyserverHandler

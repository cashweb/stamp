import axios from 'axios'
import { splitEvery } from 'ramda'
import { Payload, Message, MessagePage, MessageSet, Profile } from './relay_pb'
import stealth from './stealth_pb'
import wrapper from '../auth_wrapper/wrapper_pb'
import pop from '../pop'
import { pingTimeout, relayReconnectInterval } from '../utils/constants'
import VCard from 'vcf'
import EventEmitter from 'events'
import { constructStealthEntry, constructReplyEntry, constructTextEntry, constructImageEntry, constructMessage } from './constructors'
import { entryToImage, arrayBufferToBase64 } from '../utils/image'
import { constructStampHDPrivateKey, constructStealthPrivKey } from './crypto'
import { messageMixin } from './extension'
import { calcId } from '../wallet/helpers'
import assert from 'assert'

const WebSocket = window.require('ws')
const cashlib = require('bitcore-lib-cash')

export class RelayClient {
  constructor (url, wallet, electrumClient, { getPubKey, getStoredMessage }) {
    this.url = url
    this.events = new EventEmitter()
    this.wallet = wallet
    this.electrumClient = electrumClient
    this.getPubKey = getPubKey
    this.getStoredMessage = getStoredMessage
  }

  setToken (token) {
    this.token = token
  }

  setWallet (wallet) {
    this.wallet = wallet
  }

  setElectrumClient (electrumClient) {
    this.electrumClient = electrumClient
  }

  async profilePaymentRequest (addr) {
    const url = `${this.url}/profiles/${addr}`
    return await pop.getPaymentRequest(url, 'put')
  }

  async getRelayData (addr) {
    const url = `${this.url}/profiles/${addr}`
    const response = await axios({
      method: 'get',
      url,
      responseType: 'arraybuffer'
    })
    const metadata = wrapper.AuthWrapper.deserializeBinary(response.data)

    // Get PubKey
    const pubKey = metadata.getPublicKey()

    const payload = Profile.deserializeBinary(metadata.getPayload())

    // Find vCard
    function isVCard (entry) {
      return entry.getKind() === 'vcard'
    }
    const entryList = payload.getEntriesList()
    const rawCard = entryList.find(isVCard).getBody() // TODO: Cancel if not found
    const strCard = new TextDecoder().decode(rawCard)
    const vCard = new VCard().parse(strCard)

    const name = vCard.data.fn._data

    // const bio = vCard.data.note._data
    const bio = ''

    // Get avatar
    function isAvatar (entry) {
      return entry.getKind() === 'avatar'
    }
    const avatarEntry = entryList.find(isAvatar)
    const rawAvatar = avatarEntry.getBody()

    const value = avatarEntry.getHeadersList()[0].getValue()
    const avatarDataURL = 'data:' + value + ';base64,' + arrayBufferToBase64(rawAvatar)

    const profile = {
      name,
      bio,
      avatar: avatarDataURL,
      pubKey
    }
    const inbox = {
      acceptancePrice: 100 // TODO: Parse
    }
    const relayData = {
      profile,
      inbox
    }
    return relayData
  }

  setUpWebsocket (addr) {
    const url = `${this.url}/ws/${addr}`
    const opts = { headers: { Authorization: this.token } }
    const socket = new WebSocket(url, opts)

    socket.onmessage = event => {
      const buffer = event.data
      const message = Message.deserializeBinary(buffer)
      this.receiveMessage(message).catch(err => console.error(err))
    }

    const disconnectHandler = () => {
      this.events.emit('disconnected')
      setTimeout(() => {
        this.setUpWebsocket(addr, this.token)
      }, relayReconnectInterval)
    }

    socket.onerror = (err) => {
      this.events.emit('error', err)
    }
    socket.onclose = () => {
      disconnectHandler()
    }
    socket.onopen = () => {
      this.events.emit('opened')
    }

    // Setup ping timeout
    this.pingTimeout = setTimeout(() => {
      socket.terminate()
    }, pingTimeout)

    socket.on('ping', () => {
      clearTimeout(this.pingTimeout)
      this.pingTimeout = setTimeout(() => {
        socket.terminate()
      }, pingTimeout)
    })
  }

  async getAcceptancePrice (addr) {
    // Get fee
    let acceptancePrice
    try {
      const filters = await this.getFilter(addr)
      const priceFilter = filters.getPriceFilter()
      acceptancePrice = priceFilter.getAcceptancePrice()
    } catch (err) {
      acceptancePrice = 'Unknown'
    }
    return acceptancePrice
  }

  async getRawPayload (addr, digest) {
    const url = `${this.url}/payloads/${addr}`

    const hexDigest = Array.prototype.map.call(digest, x => ('00' + x.toString(16)).slice(-2)).join('')
    const response = await axios({
      method: 'get',
      url,
      headers: {
        Authorization: this.token
      },
      params: {
        digest: hexDigest
      },
      responseType: 'arraybuffer'
    })
    return response.data
  }

  async getProfile (addr, digest) {
    const rawPayload = await this.getRawPayload(addr, digest)
    const payload = Profile.deserializeBinary(rawPayload)
    return payload
  }

  async deleteMessage (digest) {
    assert(typeof digest === 'string')

    try {
      const message = this.getStoredMessage(digest)
      assert(message, 'message not found?')

      // Send utxos to a change address
      const changeAddresses = Object.keys(this.wallet.changeAddresses)
      const changeAddress = changeAddresses[changeAddresses.length * Math.random() << 0]
      await this.wallet.forwardUTXOsToAddress({ utxos: message.outpoints, address: changeAddress })

      const url = `${this.url}/messages/${this.wallet.myAddressStr}`
      await axios({
        method: 'delete',
        url,
        headers: {
          Authorization: this.token
        },
        params: {
          digest
        }
      })
    } catch (err) {
      // TODO: Notify user of error
      console.error(err)
    }
  }

  async putProfile (addr, metadata) {
    const rawProfile = metadata.serializeBinary()
    const url = `${this.url}/profiles/${addr}`
    await axios({
      method: 'put',
      url: url,
      headers: {
        Authorization: this.token
      },
      data: rawProfile
    })
  }

  async getMessages (addr, startTime, endTime) {
    const url = `${this.url}/messages/${addr}`
    const response = await axios({
      method: 'get',
      url: url,
      headers: {
        Authorization: this.token
      },
      params: {
        // eslint-disable-next-line @typescript-eslint/camelcase
        start_time: startTime,
        // eslint-disable-next-line @typescript-eslint/camelcase
        end_time: endTime
      },
      responseType: 'arraybuffer'
    })

    if (response.status === 200) {
      const messagePage = MessagePage.deserializeBinary(response.data)
      return messagePage
    }
  }

  async messagePaymentRequest (addr) {
    const url = `${this.url}/messages/${addr}`
    return await pop.getPaymentRequest(url, 'get')
  }

  async sendPayment (paymentUrl, payment) {
    return await pop.sendPayment(paymentUrl, payment)
  }

  async pushMessages (addr, messageSet) {
    const rawMetadata = messageSet.serializeBinary()
    const url = `${this.url}/messages/${addr}`
    await axios({
      method: 'put',
      url: url,
      data: rawMetadata
    })
  }

  sendMessageImpl ({ addr, items, stampAmount, errCount = 0 }) {
    const wallet = this.wallet
    const sourcePrivateKey = wallet.identityPrivKey
    const destinationPublicKey = this.getPubKey(addr)

    const usedIDs = []
    const outpoints = []
    const transactions = []
    // Construct payload
    const entries = items.map(
      item => {
        // TODO: internal type does not match protocol. Consistency is good.
        if (item.type === 'stealth') {
          const { paymentEntry, transactionBundle } = constructStealthEntry({ ...item, wallet: this.wallet, destPubKey: destinationPublicKey })
          outpoints.push(...transactionBundle.map(({ transaction, vouts, usedIds }) => {
            transactions.push(transaction)
            usedIDs.push(...usedIds)
            return vouts.map(vout => ({
              type: 'stealth',
              txId: transaction.id,
              satoshis: transaction.outputs[vout].satoshis,
              outputIndex: vout
            }))
          }).flat(1)
          )
          return paymentEntry
        }
        // TODO: internal type does not match protocol. Consistency is good.
        if (item.type === 'text') {
          return constructTextEntry({ ...item })
        }
        if (item.type === 'reply') {
          return constructReplyEntry({ ...item })
        }
        if (item.type === 'image') {
          return constructImageEntry({ ...item })
        }
      }
    )
    const senderAddress = this.wallet.myAddressStr

    // Construct payload
    const payload = new Payload()
    payload.setTimestamp(Date.now())
    payload.setEntriesList(entries)
    const plainTextPayload = payload.serializeBinary()

    // Construct message
    try {
      const { message, transactionBundle, payloadDigest } = constructMessage(wallet, plainTextPayload, sourcePrivateKey, destinationPublicKey, stampAmount)
      const payloadDigestHex = payloadDigest.toString('hex')

      // Add localy
      this.events.emit('messageSending', { addr, senderAddress, index: payloadDigestHex, items, outpoints, transactions })

      outpoints.push(...transactionBundle.map(({ transaction, vouts, usedIds }) => {
        transactions.push(transaction)
        usedIDs.push(...usedIds)
        return vouts.map(vout => ({
          type: 'stamp',
          txId: transaction.id,
          satoshis: transaction.outputs[vout].satoshis,
          outputIndex: vout
        }))
      }).flat(1))
      const messageSet = new MessageSet()
      messageSet.addMessages(message)
      const destinationAddr = destinationPublicKey.toAddress('testnet').toLegacyAddress()
      const client = this.wallet.electrumClient

      // Send messages
      Promise.all(transactions.map(transaction => {
        console.log('broadcasting txn')
        console.log(transaction)
        return client.request('blockchain.transaction.broadcast', transaction.toString())
      }))
        .then(() => this.pushMessages(destinationAddr, messageSet))
        .then(() => this.events.emit('messageSent', { addr, senderAddress, index: payloadDigestHex, items, outpoints, transactions }))
        .catch(async (err) => {
          console.error(err)
          if (err.response) {
            console.error(err.response)
          }
          // Unfreeze UTXOs
          await Promise.all(usedIDs.map(id => wallet.fixFrozenUTXO(id)))
          errCount += 1
          console.log('error sending message', err)
          if (errCount >= 3) {
            console.log(`unable to send message after ${errCount} retries`)
            return
          }
          // TODO: Currently, we can lose stealth transaction data if the stamp inputs fail.
          // Also, retries messages are not deleted from the message output window.
          // Both of these issues need to be fixed.
          this.sendMessageImpl({ addr, items, stampAmount, errCount })
        })
    } catch (err) {
      console.error(err)
      const payloadDigestHex = err.payloadDigest.toString('hex')

      this.events.emit('messageSendError', { addr, senderAddress, index: payloadDigestHex, items, outpoints, transactions })
    }
  }

  // Stub for original API
  // TODO: Fix clients to not use these APIs at all
  sendMessage ({ addr, text, replyDigest, stampAmount }) {
    // Send locally
    const items = [
      {
        type: 'text',
        text
      }
    ]
    if (replyDigest) {
      items.unshift({
        type: 'reply',
        payloadDigest: replyDigest
      })
    }
    this.sendMessageImpl({ addr, items, stampAmount })
  }

  sendStealthPayment ({ addr, stampAmount, amount, memo }) {
    // Send locally
    const items = [
      {
        type: 'stealth',
        amount
      }
    ]
    if (memo !== '') {
      items.push(
        {
          type: 'text',
          text: memo
        })
    }
    this.sendMessageImpl({ addr, items, stampAmount })
  }

  sendImage ({ addr, image, caption, replyDigest, stampAmount }) {
    const items = [
      {
        type: 'image',
        image
      }
    ]
    if (caption !== '') {
      items.push(
        {
          type: 'text',
          text: caption
        })
    }
    if (replyDigest) {
      items.unshift({
        type: 'reply',
        payloadDigest: replyDigest
      })
    }

    this.sendMessageImpl({ addr, items, stampAmount })
  }

  async receiveMessage (message, receivedTime = Date.now()) {
    // Parse message
    Object.assign(Message.prototype, messageMixin)
    const parsedMessage = message.parse()

    const sourceAddr = parsedMessage.sourcePublicKey.toAddress('testnet').toCashAddress() // TODO: Make generic
    const wallet = this.wallet
    const myAddress = wallet.myAddressStr
    const outbound = (sourceAddr === myAddress)
    const serverTime = message.received_time

    // if this client sent the message, we already have the data and don't need to process it or get the payload again
    if (parsedMessage.payloadDigest.length !== 0) {
      const payloadDigestHex = Array.prototype.map.call(parsedMessage.payloadDigest, x => ('00' + x.toString(16)).slice(-2)).join('')
      const message = this.getStoredMessage(payloadDigestHex)
      if (message) {
        // TODO: We really should handle unfreezing UTXOs here via a callback in the future.
        return
      }
    }

    const getPayload = async (payloadDigest, messagePayload) => {
      if (messagePayload.length !== 0) {
        return messagePayload
      }
      try {
        return new Uint8Array(await this.getRawPayload(myAddress, payloadDigest))
      } catch (err) {
        console.error(err)
        // TODO: Handle
      }
    }

    // Get payload if serialized payload is missing
    const rawCipherPayload = await getPayload(parsedMessage.payloadDigest, parsedMessage.payload)

    const payloadDigest = cashlib.crypto.Hash.sha256(rawCipherPayload)
    if (!payloadDigest.equals(parsedMessage.payloadDigest)) {
      console.error('Payload received doesn\'t match digest. Refusing to process message', payloadDigest, parsedMessage.payloadDigest)
      return
    }

    const destinationAddr = parsedMessage.destinationPublicKey.toAddress('testnet').toCashAddress()

    if (outbound && myAddress === destinationAddr) {
      // TODO: Process self sends
      console.log('self send')
      return
    }

    // Add UTXO
    const stampOutpoints = parsedMessage.stamp.getStampOutpointsList()
    const outpoints = []

    let stampValue = 0

    const stampRootHDPrivKey = constructStampHDPrivateKey(payloadDigest, wallet.identityPrivKey)
      .deriveChild(44)
      .deriveChild(145)

    for (const [i, stampOutpoint] of stampOutpoints.entries()) {
      const stampTxRaw = Buffer.from(stampOutpoint.getStampTx())
      const stampTx = cashlib.Transaction(stampTxRaw)
      const txId = stampTx.hash
      const vouts = stampOutpoint.getVoutsList()
      const stampTxHDPrivKey = stampRootHDPrivKey.deriveChild(i)
      if (outbound) {
        for (const input of stampTx.inputs) {
          // In order to update UTXO state more quickly, go ahead and remove the inputs from our set immediately
          const utxoId = calcId({ txId: input.prevTxId.toString('hex'), outputIndex: input.outputIndex })
          wallet.removeUTXO(utxoId)
        }
      }
      for (const [j, outputIndex] of vouts.entries()) {
        const output = stampTx.outputs[outputIndex]
        const satoshis = output.satoshis
        const address = output.script.toAddress('testnet') // TODO: Make generic
        stampValue += satoshis

        // Also note, we should use an HD key here.
        const outputPrivKey = stampTxHDPrivKey
          .deriveChild(j)
          .privateKey

        // Network doesn't really matter here, just serves as a placeholder to avoid needing to compute the
        // HASH160(SHA256(point)) ourself
        // Also, ensure the point is compressed first before calculating the address so the hash is deterministic
        const computedAddress = new cashlib.PublicKey(cashlib.crypto.Point.pointToCompressed(outputPrivKey.toPublicKey().point)).toAddress('testnet')
        if (!outbound && !address.toBuffer().equals(computedAddress.toBuffer())) {
          // Assume outbound addresses were valid.  Otherwise we need to calclate a different
          // derivation then based on our identity address.
          console.error('invalid stamp address, ignoring')
          continue
        }

        const stampOutput = {
          address,
          privKey: outbound ? null : outputPrivKey, // This is okay, we don't add it to the wallet.
          satoshis,
          txId,
          outputIndex,
          type: 'stamp',
          payloadDigest
        }
        outpoints.push(stampOutput)
        if (outbound) {
          // In order to update UTXO state more quickly, go ahead and remove the inputs from our set immediately
          continue
        }
        wallet.addUTXO(stampOutput)
      }
    }

    const rawPayload = parsedMessage.open(wallet.identityPrivKey)
    const payload = Payload.deserializeBinary(rawPayload)

    // Ignore messages below acceptance price
    let stealthValue = 0

    // Decode entries
    const entriesList = payload.getEntriesList()
    const newMsg = {
      outbound,
      status: 'confirmed',
      items: [],
      serverTime,
      receivedTime,
      outpoints,
      senderAddress: sourceAddr
    }
    for (const index in entriesList) {
      const entry = entriesList[index]
      // If addr data doesn't exist then add it
      const kind = entry.getKind()
      if (kind === 'reply') {
        const entryData = entry.getBody()
        const payloadDigest = Buffer.from(entryData).toString('hex')
        newMsg.items.push({
          type: 'reply',
          payloadDigest
        })
      } else if (kind === 'text-utf8') {
        const entryData = entry.getBody()
        const text = new TextDecoder().decode(entryData)
        newMsg.items.push({
          type: 'text',
          text
        })
      } else if (kind === 'stealth-payment') {
        const entryData = entry.getBody()
        const stealthMessage = stealth.StealthPaymentEntry.deserializeBinary(entryData)

        // Add stealth outputs
        const outpointsList = stealthMessage.getOutpointsList()
        const ephemeralPubKeyRaw = stealthMessage.getEphemeralPubKey()
        const ephemeralPubKey = cashlib.PublicKey.fromBuffer(ephemeralPubKeyRaw)
        const stealthHDPrivKey = constructStealthPrivKey(ephemeralPubKey, wallet.identityPrivKey)
        for (const [i, outpoint] of outpointsList.entries()) {
          const stealthTxRaw = Buffer.from(outpoint.getStealthTx())
          const stealthTx = cashlib.Transaction(stealthTxRaw)
          const txId = stealthTx.hash
          const vouts = outpoint.getVoutsList()

          if (outbound) {
            for (const input of stealthTx.inputs) {
              // Don't add these outputs to our wallet. They're the other persons
              const utxoId = calcId({ txId: input.prevTxId.toString('hex'), outputIndex: input.outputIndex })
              wallet.removeUTXO(utxoId)
            }
          }

          for (const [j, outputIndex] of vouts.entries()) {
            const output = stealthTx.outputs[outputIndex]
            const satoshis = output.satoshis

            const outpointPrivKey = stealthHDPrivKey
              .deriveChild(44)
              .deriveChild(145)
              .deriveChild(i)
              .deriveChild(j)
              .privateKey
            const address = output.script.toAddress('testnet') // TODO: Make generic
            // Network doesn't really matter here, just serves as a placeholder to avoid needing to compute the
            // HASH160(SHA256(point)) ourself
            // Also, ensure the point is compressed first before calculating the address so the hash is deterministic
            const computedAddress = new cashlib.PublicKey(cashlib.crypto.Point.pointToCompressed(outpointPrivKey.toPublicKey().point)).toAddress('testnet')
            if (!outbound && !address.toBuffer().equals(computedAddress.toBuffer())) {
              console.error('invalid stealth address, ignoring')
              continue
            }
            // total up the satoshis only if we know the txn was valid
            stealthValue += satoshis

            const stampOutput = {
              address,
              satoshis,
              outputIndex,
              privKey: outpointPrivKey,
              txId,
              type: 'stealth',
              payloadDigest
            }
            outpoints.push(stampOutput)
            if (outbound) {
              // Don't add these outputs to our wallet. They're the other persons
              continue
            }
            wallet.addUTXO(stampOutput)
          }
        }
        newMsg.items.push({
          type: 'stealth',
          amount: stealthValue
        })
      } else if (kind === 'image') {
        const image = entryToImage(entry)

        // TODO: Save to folder instead of in Vuex
        newMsg.items.push({
          type: 'image',
          image
        })
      }
    }

    const copartyPubKey = outbound ? parsedMessage.destinationPublicKey : parsedMessage.sourcePublicKey
    const payloadDigestHex = payloadDigest.toString('hex')

    this.events.emit('receivedMessage', { outbound, copartyPubKey, index: payloadDigestHex, newMsg: Object.freeze({ ...newMsg, stampValue, totalValue: stampValue + stealthValue }) })
  }

  async refresh ({ lastReceived } = {}) {
    const wallet = this.wallet
    const myAddressStr = wallet.myAddressStr
    console.log('refreshing', lastReceived, myAddressStr)
    const messagePage = await this.getMessages(myAddressStr, lastReceived || 0, null)
    const messageList = messagePage.getMessagesList()
    console.log('processing messages')
    const messageChunks = splitEvery(5, messageList)
    for (const messageChunk of messageChunks) {
      await new Promise((resolve) => {
        setTimeout(() => {
          for (const message of messageChunk) {
            // TODO: Check correct destination
            // const destPubKey = timedMessage.getDestination()
            // Here we are ensuring that their are yields between messages to the event loop.
            // Ideally, we move this to a webworker in the future.
            this.receiveMessage(message).then(resolve).catch((err) => {
              console.error('Unable to deserialize message:', err)
              resolve()
            })
          }
        }, 0)
      })
    }

    // const t0 = performance.now()
    // await this.wallet.fixUTXOs().then(() => {
    //   const fixUTXOsTime = performance.now()
    //   console.log(`fixUTXOsTime UTXOs took ${fixUTXOsTime - t0} ms`)
    // })
  }
}

export default RelayClient

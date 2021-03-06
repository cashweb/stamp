import axios from 'axios'
import { splitEvery } from 'ramda'
import { Payload, Message, MessagePage, MessageSet, Profile } from './relay_pb'
import stealth from './stealth_pb'
import p2pkh from './p2pkh_pb'

import { AuthWrapper } from '../auth_wrapper/wrapper_pb'
import pop from '../pop'
// TODO: Relay code should not depend on Stamp base code. Fix this import
import VCard from 'vcf'
import EventEmitter from 'events'
import { MessageConstructor } from './constructors'
import { entryToImage, arrayBufferToBase64 } from './images'

import { PayloadConstructor } from './crypto'
import { messageMixin } from './extension'
import { calcId } from '../wallet/helpers'
import assert from 'assert'
import paymentrequest from '../bip70/paymentrequest_pb'

import WebSocket from 'isomorphic-ws'
import { PublicKey, crypto, Transaction, Networks, Address } from 'bitcore-lib-xpi'

export class ReadOnlyRelayClient {
  constructor (url, networkName) {
    this.url = url
    this.networkName = networkName
    this.networkPrefix = Networks.get(networkName).prefix
  }

  toAPIAddressString (address) {
    return new Address(new Address(address).hashBuffer, Networks.get(this.networkName, undefined)).toCashAddress()
  }

  async getRelayData (address) {
    const addressLegacy = this.toAPIAddressString(address)

    const url = `${this.url}/profiles/${addressLegacy}`
    const response = await axios({
      method: 'get',
      url,
      responseType: 'arraybuffer'
    })
    const metadata = AuthWrapper.deserializeBinary(response.data)

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

  async getAcceptancePrice (address) {
    const addressLegacy = this.toAPIAddressString(address)

    // Get fee
    let acceptancePrice
    try {
      const filters = await this.getFilter(addressLegacy)
      const priceFilter = filters.getPriceFilter()
      acceptancePrice = priceFilter.getAcceptancePrice()
    } catch (err) {
      acceptancePrice = 'Unknown'
    }
    return acceptancePrice
  }

  async getRawPayload (address, digest) {
    const addressLegacy = this.toAPIAddressString(address)

    const url = `${this.url}/payloads/${addressLegacy}`

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
}

export class RelayClient extends ReadOnlyRelayClient {
  constructor (url, wallet, electrumClientPromise, { networkName = 'testnet', relayReconnectInterval = 10_000, getPubKey, messageStore }) {
    super(url, networkName)
    assert(networkName, 'Missing networkName while initializing RelayClient')
    assert(url, 'Missing url while initializing RelayClient')
    assert(getPubKey, 'Missing getPubKey while initializing RelayClient')
    assert(messageStore, 'Missing messageStore while initializing RelayClient')

    this.url = url
    this.events = new EventEmitter()
    this.wallet = wallet
    this.electrumClientPromise = electrumClientPromise
    this.getPubKey = getPubKey
    this.messageStore = messageStore
    this.relayReconnectInterval = relayReconnectInterval
    this.payloadConstructor = new PayloadConstructor({ networkName })
    this.messageConstructor = new MessageConstructor({ networkName, wallet })
  }

  setToken (token) {
    this.token = token
  }

  setWallet (wallet) {
    this.wallet = wallet
  }

  async profilePaymentRequest (address) {
    const addressLegacy = this.toAPIAddressString(address)

    const url = `${this.url}/profiles/${addressLegacy}`
    return await pop.getPaymentRequest(url, 'put')
  }

  setUpWebsocket (address) {
    const addressLegacy = this.toAPIAddressString(address)

    const url = new URL(`/ws/${addressLegacy}`, this.url)
    url.protocol = 'wss'
    url.searchParams.set('access_token', this.token)
    const socket = new WebSocket(url.toString())
    socket.binaryType = 'arraybuffer'

    socket.onmessage = event => {
      const buffer = event.data
      const message = Message.deserializeBinary(buffer)
      this.receiveMessage(message).catch(err => console.error(err))
    }

    const disconnectHandler = () => {
      this.events.emit('disconnected')
      setTimeout(() => {
        this.setUpWebsocket(address, this.token)
      }, this.relayReconnectInterval)
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
  }

  async getPayload (address, digest) {
    const addressLegacy = this.toAPIAddressString(address)

    const rawPayload = await this.getRawPayload(addressLegacy, digest)
    const payload = Payload.deserializeBinary(rawPayload)
    return payload
  }

  async deleteMessage (digest) {
    assert(typeof digest === 'string')

    try {
      const message = await this.messageStore.getMessage(digest)
      assert(message, 'message not found?')

      // Send utxos to a change address
      const changeAddresses = Object.keys(this.wallet.changeAddresses)
      const changeAddress = changeAddresses[changeAddresses.length * Math.random() << 0]
      await this.wallet.forwardUTXOsToAddress({ utxos: message.newMsg.outpoints, address: changeAddress })

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

  async putProfile (address, metadata) {
    const addressLegacy = this.toAPIAddressString(address)

    const rawProfile = metadata.serializeBinary()
    const url = `${this.url}/profiles/${addressLegacy}`
    await axios({
      method: 'put',
      url: url,
      headers: {
        Authorization: this.token
      },
      data: rawProfile
    })
  }

  async getMessages (address, startTime, endTime, retries = 3) {
    const addressLegacy = this.toAPIAddressString(address)

    const url = `${this.url}/messages/${addressLegacy}`
    try {
      const response = await axios({
        method: 'get',
        url: url,
        headers: {
          Authorization: this.token
        },
        params: {
          start_time: startTime,
          end_time: endTime
        },
        responseType: 'arraybuffer'
      })
      assert(response.status === 200, 'We should not be here')
      const messagePage = MessagePage.deserializeBinary(response.data)
      return messagePage
    } catch (err) {
      const response = err.response
      if (response.status !== 402) {
        throw err
      }

      if (retries === 0) {
        throw err
      }

      // TODO: We need to ensure this payment is reasonable to the user, otherwise the relay server
      // could request amounts of money that are ridiculous.

      const paymentRequest = paymentrequest.PaymentRequest.deserializeBinary(response.data)
      const serializedPaymentDetails = paymentRequest.getSerializedPaymentDetails()
      const paymentDetails = paymentrequest.PaymentDetails.deserializeBinary(serializedPaymentDetails)

      const { paymentUrl, payment } = await pop.constructPaymentTransaction(this.wallet, paymentDetails)
      const paymentUrlFull = new URL(paymentUrl, this.url)
      console.log('Sending payment to', paymentUrlFull.href)
      const { token } = await pop.sendPayment(paymentUrlFull.href, payment)
      this.setToken(token)
      return this.getMessages(address, startTime, endTime, retries--)
    }
  }

  async messagePaymentRequest (address) {
    const addressLegacy = this.toAPIAddressString(address)

    const url = `${this.url}/messages/${addressLegacy}`
    return await pop.getPaymentRequest(url, 'get')
  }

  async sendPayment (paymentUrl, payment) {
    return await pop.sendPayment(paymentUrl, payment)
  }

  async pushMessages (address, messageSet) {
    const addressLegacy = this.toAPIAddressString(address)

    const rawMetadata = messageSet.serializeBinary()
    const url = `${this.url}/messages/${addressLegacy}`
    await axios({
      method: 'put',
      url: url,
      data: rawMetadata
    })
  }

  async sendMessageImpl ({ address, items, stampAmount, errCount = 0, previousHash }) {
    const wallet = this.wallet
    const sourcePrivateKey = wallet.identityPrivKey
    const destinationPublicKey = address === wallet.myAddressStr ? wallet.identityPrivKey.publicKey : this.getPubKey(address)

    const usedIDs = []
    const outpoints = []
    const transactions = []
    // Construct payload
    const entries = await Promise.all(items.map(
      async item => {
        // TODO: internal type does not match protocol. Consistency is good.
        if (item.type === 'stealth') {
          const { paymentEntry, transactionBundle } = this.messageConstructor.constructStealthEntry({ ...item, wallet: this.wallet, destPubKey: destinationPublicKey })
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
          return this.messageConstructor.constructTextEntry({ ...item })
        }
        if (item.type === 'reply') {
          return this.messageConstructor.constructReplyEntry({ ...item })
        }
        if (item.type === 'image') {
          return this.messageConstructor.constructImageEntry({ ...item })
        }
        if (item.type === 'p2pkh') {
          const { entry, transaction, usedIDs } = this.messageConstructor.constructP2PKHEntry({ ...item, wallet: this.wallet })

          transactions.push(transaction)
          usedIDs.push(...usedIDs)

          return entry
        }
      }
    ))

    const senderAddress = this.wallet.myAddressStr

    // Construct payload
    const payload = new Payload()
    payload.setTimestamp(Date.now())
    payload.setEntriesList(entries)
    const plainTextPayload = payload.serializeBinary()

    // Construct message
    try {
      const { message, transactionBundle, payloadDigest } = this.messageConstructor.constructMessage(wallet, plainTextPayload, sourcePrivateKey, destinationPublicKey, stampAmount)
      const payloadDigestHex = payloadDigest.toString('hex')

      // Add localy
      this.events.emit('messageSending', { address, senderAddress, index: payloadDigestHex, items, outpoints, previousHash, transactions })

      outpoints.push(...transactionBundle.map(({ transaction, vouts, usedIds }) => {
        transactions.push(transaction)
        usedIDs.push(...usedIds)
        return vouts.map(vout => ({
          type: 'stamp',
          txId: transaction.id,
          satoshis: transaction.outputs[vout].satoshis,
          outputIndex: vout
        }))
      }).flat(1)
      )

      const messageSet = new MessageSet()
      messageSet.addMessages(message)

      const destinationAddress = destinationPublicKey.toAddress(this.networkName).toCashAddress()
      const electrumClient = await this.wallet.electrumClientPromise
      Promise.all(transactions.map(async (transaction) => {
        console.log('Broadcasting a transaction', transaction.id, transaction.toString())
        await electrumClient.request('blockchain.transaction.broadcast', transaction.toString())
        console.log('Finished broadcasting tx', transaction.id)
      }))
        .then(() => this.pushMessages(destinationAddress, messageSet))
        .then(async () => {
          this.events.emit('messageSent', { address, senderAddress, index: payloadDigestHex, items, outpoints, transactions })
          // TODO: we shouldn't be dealing with this here. Leaky abstraction
          await Promise.all(usedIDs.map(id => wallet.storage.deleteOutpoint(id)))
        })
        .catch(async (err) => {
          console.error(err)
          if (err.response) {
            console.error(err.response)
          }
          usedIDs.forEach(id => wallet.fixOutpoint(id))
          errCount += 1
          console.log('error sending message', err)
          if (errCount >= 3) {
            this.events.emit('messageSendError', { address, senderAddress, index: payloadDigestHex, items, outpoints, transactions })
            console.log(`unable to send message after ${errCount} retries`)
            return
          }
          // TODO: Currently, we can lose stealth transaction data if the stamp inputs fail.
          // Also, retries messages are not deleted from the message output window.
          // Both of these issues need to be fixed.
          await this.sendMessageImpl({ address, items, stampAmount, errCount, previousHash: payloadDigestHex })
        })
    } catch (err) {
      console.error(err)
      const payloadDigestHex = err.payloadDigest.toString('hex')
      this.events.emit('messageSendError', { address, senderAddress, index: payloadDigestHex, items, outpoints, transactions })
    }
  }

  // Stub for original API
  // TODO: Fix clients to not use these APIs at all
  async sendMessage ({ address, text, replyDigest, stampAmount }) {
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
    await this.sendMessageImpl({ address, items, stampAmount })
  }

  async sendStealthPayment ({ address, stampAmount, amount, memo }) {
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
    await this.sendMessageImpl({ address, items, stampAmount })
  }

  async sendImage ({ address, image, caption, replyDigest, stampAmount }) {
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

    await this.sendMessageImpl({ address, items, stampAmount })
  }

  // Stub for original API
  // TODO: Fix clients to not use these APIs at all
  async sendToPubKeyHash ({ address, amount }) {
    // Send locally
    const items = [
      {
        type: 'p2pkh',
        address,
        amount
      }
    ]
    console.log(items)
    await this.sendMessageImpl({ address: this.wallet.myAddressStr, items })
  }

  receiveSelfSend ({ payload } = {}) {
    // Decode entries
    const entriesList = payload.getEntriesList()

    for (const index in entriesList) {
      const entry = entriesList[index]
      // If address data doesn't exist then add it
      const kind = entry.getKind()
      if (kind === 'p2pkh') {
        const entryData = entry.getBody()
        const p2pkhMessage = p2pkh.P2PKHEntry.deserializeBinary(entryData)

        // Add stealth outputs
        const transactionRaw = p2pkhMessage.getTransaction()
        const p2pkhTxRaw = Buffer.from(transactionRaw)
        const p2pkhTxR = Transaction(p2pkhTxRaw)

        for (const input of p2pkhTxR.inputs) {
          // Don't add these outputs to our wallet. They're the other persons
          const utxoId = calcId({ txId: input.prevTxId.toString('hex'), outputIndex: input.outputIndex })
          this.wallet.deleteOutpoint(utxoId)
        }

        continue
      }
    }
  }

  async receiveMessage (message, receivedTime = Date.now()) {
    // Parse message
    Object.assign(Message.prototype, messageMixin(this.networkPrefix))
    const preParsedMessage = message.parse()

    const senderAddress = preParsedMessage.sourcePublicKey.toAddress(this.networkName).toCashAddress() // TODO: Make generic
    const wallet = this.wallet
    const myAddress = wallet.myAddressStr
    const outbound = (senderAddress === myAddress)
    const serverTime = preParsedMessage.receivedTime

    // if this client sent the message, we already have the data and don't need to process it or get the payload again
    if (preParsedMessage.payloadDigest.length !== 0) {
      const payloadDigestHex = Array.prototype.map.call(preParsedMessage.payloadDigest, x => ('00' + x.toString(16)).slice(-2)).join('')
      const message = await this.messageStore.getMessage(payloadDigestHex)
      if (message) {
        console.log('Already have message', payloadDigestHex)
        // TODO: We really should handle unfreezing UTXOs here via a callback in the future.
        return
      }
      console.log('Message not found locally', payloadDigestHex)
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
    // TODO: write a test that we actually use these payloads in the future.
    // :facepalm:
    const rawCipherPayload = await getPayload(preParsedMessage.payloadDigest, preParsedMessage.payload)
    console.log('Processing message payload', rawCipherPayload.length)

    // If we had to fetch the payload, let's actually use it!
    preParsedMessage.payload = rawCipherPayload

    // Just to be clear that this is where the message is now valid.
    const parsedMessage = preParsedMessage

    const payloadDigest = crypto.Hash.sha256(rawCipherPayload)
    if (!payloadDigest.equals(parsedMessage.payloadDigest)) {
      console.error('Payload received doesn\'t match digest. Refusing to process message', payloadDigest, parsedMessage.payloadDigest)
      return
    }

    const destinationAddress = parsedMessage.destinationPublicKey.toAddress(this.networkName).toCashAddress()

    // Add UTXO
    const stampOutpoints = parsedMessage.stamp.getStampOutpointsList()
    const outpoints = []

    let stampValue = 0

    const stampRootHDPrivKey = this.payloadConstructor.constructStampHDPrivateKey(payloadDigest, wallet.identityPrivKey)
      .deriveChild(44)
      .deriveChild(145)

    for (const [i, stampOutpoint] of stampOutpoints.entries()) {
      const stampTxRaw = Buffer.from(stampOutpoint.getStampTx())
      const stampTx = Transaction(stampTxRaw)
      const txId = stampTx.hash
      const vouts = stampOutpoint.getVoutsList()
      const stampTxHDPrivKey = stampRootHDPrivKey.deriveChild(i)
      if (outbound) {
        for (const input of stampTx.inputs) {
          // In order to update UTXO state more quickly, go ahead and remove the inputs from our set immediately
          const utxoId = calcId({ txId: input.prevTxId.toString('hex'), outputIndex: input.outputIndex })
          await wallet.deleteOutpoint(utxoId)
        }
      }
      for (const [j, outputIndex] of vouts.entries()) {
        const output = stampTx.outputs[outputIndex]
        const satoshis = output.satoshis
        const address = output.script.toAddress(this.networkName) // TODO: Make generic
        stampValue += satoshis

        // Also note, we should use an HD key here.
        const outputPrivKey = stampTxHDPrivKey
          .deriveChild(j)
          .privateKey

        // Network doesn't really matter here, just serves as a placeholder to avoid needing to compute the
        // HASH160(SHA256(point)) ourself
        // Also, ensure the point is compressed first before calculating the address so the hash is deterministic
        const computedAddress = new PublicKey(crypto.Point.pointToCompressed(outputPrivKey.toPublicKey().point)).toAddress(this.networkName)
        if (!outbound && !address.toBuffer().equals(computedAddress.toBuffer())) {
          // Assume outbound addresses were valid.  Otherwise we need to calclate a different
          // derivation then based on our identity address.
          console.error('invalid stamp address, ignoring')
          continue
        }

        const stampOutput = {
          address: address.toCashAddress(),
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
        wallet.putOutpoint(stampOutput)
      }
    }

    // Ignore messages below acceptance price
    let stealthValue = 0

    const rawPayload = outbound ? parsedMessage.openSelf(wallet.identityPrivKey) : parsedMessage.open(wallet.identityPrivKey)
    const payload = Payload.deserializeBinary(rawPayload)

    if (outbound && myAddress === destinationAddress) {
      return this.receiveSelfSend({ payload, receivedTime })
    }

    // Decode entries
    const entriesList = payload.getEntriesList()
    const newMsg = {
      outbound,
      status: 'confirmed',
      items: [],
      serverTime,
      receivedTime,
      outpoints,
      senderAddress,
      destinationAddress
    }
    for (const index in entriesList) {
      const entry = entriesList[index]
      // If address data doesn't exist then add it
      const kind = entry.getKind()
      if (kind === 'reply') {
        const entryData = entry.getBody()
        const payloadDigest = Buffer.from(entryData).toString('hex')
        newMsg.items.push({
          type: 'reply',
          payloadDigest
        })
        continue
      }

      if (kind === 'text-utf8') {
        const entryData = entry.getBody()
        const text = new TextDecoder().decode(entryData)
        newMsg.items.push({
          type: 'text',
          text
        })
        continue
      }

      if (kind === 'stealth-payment') {
        const entryData = entry.getBody()
        const stealthMessage = stealth.StealthPaymentEntry.deserializeBinary(entryData)

        // Add stealth outputs
        const outpointsList = stealthMessage.getOutpointsList()
        const ephemeralPubKeyRaw = stealthMessage.getEphemeralPubKey()
        const ephemeralPubKey = PublicKey.fromBuffer(ephemeralPubKeyRaw)
        const stealthHDPrivKey = this.messageConstructor.constructHDStealthPrivateKey(ephemeralPubKey, wallet.identityPrivKey)
        for (const [i, outpoint] of outpointsList.entries()) {
          const stealthTxRaw = Buffer.from(outpoint.getStealthTx())
          const stealthTx = Transaction(stealthTxRaw)
          const txId = stealthTx.hash
          const vouts = outpoint.getVoutsList()

          if (outbound) {
            for (const input of stealthTx.inputs) {
              // Don't add these outputs to our wallet. They're the other persons
              const utxoId = calcId({ txId: input.prevTxId.toString('hex'), outputIndex: input.outputIndex })
              await wallet.deleteOutpoint(utxoId)
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
            const address = output.script.toAddress(this.networkName) // TODO: Make generic
            // Network doesn't really matter here, just serves as a placeholder to avoid needing to compute the
            // HASH160(SHA256(point)) ourself
            // Also, ensure the point is compressed first before calculating the address so the hash is deterministic
            const computedAddress = new PublicKey(crypto.Point.pointToCompressed(outpointPrivKey.toPublicKey().point)).toAddress(this.networkName)
            if (!outbound && !address.toBuffer().equals(computedAddress.toBuffer())) {
              console.error('invalid stealth address, ignoring')
              continue
            }
            // total up the satoshis only if we know the txn was valid
            stealthValue += satoshis

            const stampOutput = {
              address: address.toCashAddress(),
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
            wallet.putOutpoint(stampOutput)
          }
        }
        newMsg.items.push({
          type: 'stealth',
          amount: stealthValue
        })
        continue
      }

      if (kind === 'image') {
        const image = entryToImage(entry)

        // TODO: Save to folder instead of in Vuex
        newMsg.items.push({
          type: 'image',
          image
        })
        continue
      }
      console.log('Entry Kind', kind)
    }

    const copartyPubKey = outbound ? parsedMessage.destinationPublicKey : parsedMessage.sourcePublicKey
    const copartyAddress = copartyPubKey.toAddress(this.networkName).toString() // TODO: Make generic
    const payloadDigestHex = payloadDigest.toString('hex')
    const finalizedMessage = { outbound, copartyAddress, copartyPubKey, index: payloadDigestHex, newMsg: Object.freeze({ ...newMsg, stampValue, totalValue: stampValue + stealthValue }) }
    await this.messageStore.saveMessage(finalizedMessage)
    this.events.emit('receivedMessage', finalizedMessage)
  }

  async refresh () {
    const wallet = this.wallet
    const myAddressStr = wallet.myAddressStr
    const lastReceived = await this.messageStore.mostRecentMessageTime()
    console.log('refreshing', lastReceived, myAddressStr)
    const messagePage = await this.getMessages(myAddressStr, lastReceived || 0, null)
    const messageList = messagePage.getMessagesList()
    console.log('processing messages')
    const messageChunks = splitEvery(20, messageList)
    for (const messageChunk of messageChunks) {
      await new Promise((resolve) => {
        setTimeout(() => {
          for (const message of messageChunk) {
            // TODO: Check correct destination
            // Here we are ensuring that their are yields between messages to the event loop.
            // Ideally, we move this to a webworker in the future.
            this.receiveMessage(message).then(resolve).catch((err) => {
              console.error('Unable to deserialize message:', err.message)
              resolve()
            })
          }
        }, 0)
      })
    }
  }

  async updateProfile (idPrivKey, profile, acceptancePrice) {
    const priceFilter = this.messageConstructor.constructPriceFilter(true, acceptancePrice, acceptancePrice, idPrivKey)
    const metadata = this.messageConstructor.constructProfileMetadata(profile, priceFilter, idPrivKey)
    await this.putProfile(idPrivKey.toAddress(this.networkName).toCashAddress().toString(), metadata)
  }

  async wipeWallet (messageDeleter) {
    const messageIterator = await this.messageStore.getIterator()
    // Todo, this rehydrate stuff is common to receiveMessage
    for await (const messageWrapper of messageIterator) {
      if (!messageWrapper.newMsg) {
        continue
      }
      const { index, copartyAddress } = messageWrapper
      await this.deleteMessage(messageWrapper.index)
      messageDeleter({ address: copartyAddress, payloadDigest: index, index })
    }
  }
}

export default RelayClient

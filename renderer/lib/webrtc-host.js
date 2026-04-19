/* global RTCPeerConnection */

const b4a = require('b4a')
const crypto = require('crypto')
const DHT = require('@hyperswarm/dht-relay')
const RelayStream = require('@hyperswarm/dht-relay/ws')

async function createWebRtcHost({ invite, rpc }) {
  const parsedInvite = new URL(invite)
  const relayUrl = parsedInvite.searchParams.get('relay') || 'ws://localhost:49443'

  const relaySocket = new WebSocket(relayUrl)
  await onceWebSocketOpen(relaySocket)

  const dht = new DHT(new RelayStream(true, relaySocket))
  const keyPair = DHT.keyPair
    ? DHT.keyPair(deriveStableSignalSeed(invite))
    : dht.defaultKeyPair
  const server = dht.createServer()

  server.on('connection', (signalSocket) => {
    void handleSignalConnection(signalSocket, { invite, rpc })
  })

  await server.listen(keyPair)

  const webLink = buildWebLink({
    signalKey: b4a.toString(keyPair.publicKey, 'hex'),
    relayUrl,
    invite
  })

  return {
    webLink,
    async close() {
      try {
        await server.close()
      } catch {}
      try {
        await dht.destroy()
      } catch {}
      try {
        relaySocket.close()
      } catch {}
    }
  }
}

function deriveStableSignalSeed(invite) {
  const value = String(invite || '').trim()
  return crypto
    .createHash('sha256')
    .update('peardrop-webrtc-share-v1\0')
    .update(value)
    .digest()
}

function buildWebLink({ signalKey, relayUrl, invite }) {
  const url = new URL('peardrops-web://join')
  url.searchParams.set('signal', signalKey)
  url.searchParams.set('relay', relayUrl)
  url.searchParams.set('invite', invite)
  return url.toString()
}

async function handleSignalConnection(signalSocket, { invite, rpc }) {
  const peer = createLinePeer(signalSocket)
  const pc = new RTCPeerConnection({ iceServers: [] })

  let dataChannel = null

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      peer.send({ type: 'candidate', candidate: event.candidate })
    }
  }

  pc.ondatachannel = (event) => {
    dataChannel = event.channel
    bindDataChannel(dataChannel, { invite, rpc })
  }

  peer.onMessage(async (message) => {
    if (message.type === 'offer' && message.sdp) {
      await pc.setRemoteDescription(message)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      peer.send({
        type: 'answer',
        sdp: answer.sdp
      })
      return
    }

    if (message.type === 'candidate' && message.candidate) {
      await pc.addIceCandidate(message.candidate)
    }
  })

  signalSocket.on('close', () => {
    if (dataChannel && dataChannel.readyState !== 'closed') dataChannel.close()
    pc.close()
  })
}

function bindDataChannel(channel, { invite, rpc }) {
  channel.onmessage = async (event) => {
    let request = null
    try {
      request = JSON.parse(String(event.data || '{}'))
    } catch {
      return
    }

    const id = typeof request.id === 'number' ? request.id : 0
    const reply = (payload) => {
      if (channel.readyState !== 'open') return
      channel.send(JSON.stringify({ id, ...payload }))
    }

    try {
      if (request.type === 'manifest') {
        const manifest = await rpc.request(3, { invite })
        reply({ ok: true, manifest })
        return
      }

      if (request.type === 'file') {
        const entry = await rpc.request(6, { invite, drivePath: request.path })
        reply({ ok: true, dataBase64: entry.dataBase64 })
        return
      }

      if (request.type === 'file-chunk') {
        const entry = await rpc.request(10, {
          invite,
          drivePath: request.path,
          offset: Number(request.offset || 0),
          length: Number(request.length || 0)
        })
        reply({
          ok: true,
          offset: Number(entry?.offset || 0),
          byteLength: Number(entry?.byteLength || 0),
          dataBase64: entry?.dataBase64 || ''
        })
        return
      }

      reply({ ok: false, error: 'Unknown request type' })
    } catch (error) {
      reply({ ok: false, error: error?.message || String(error) })
    }
  }
}

function createLinePeer(signalSocket) {
  let buffered = ''
  const listeners = new Set()

  signalSocket.on('data', (chunk) => {
    buffered += b4a.toString(chunk, 'utf8')
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (line) {
        try {
          const message = JSON.parse(line)
          for (const listener of listeners) {
            void listener(message)
          }
        } catch {}
      }
      newline = buffered.indexOf('\n')
    }
  })

  return {
    send(message) {
      signalSocket.write(b4a.from(`${JSON.stringify(message)}\n`, 'utf8'))
    },
    onMessage(listener) {
      listeners.add(listener)
    }
  }
}

function onceWebSocketOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('Relay connection failed')), {
      once: true
    })
  })
}

module.exports = {
  createWebRtcHost
}

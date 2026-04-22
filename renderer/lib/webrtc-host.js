/* global RTCPeerConnection */

const b4a = require('b4a')
const crypto = require('crypto')
const natUpnp = require('nat-upnp')
const DHT = require('@hyperswarm/dht-relay')
const RelayStream = require('@hyperswarm/dht-relay/ws')

const DEFAULT_ICE_SERVERS = [
  {
    urls: [
      'stun:stun.cloudflare.com:3478',
      'stun:global.stun.twilio.com:3478',
      'stun:stun.sipgate.net:3478',
      'stun:stun.nextcloud.com:443',
      'stun:openrelay.metered.ca:80',
      'stun:openrelay.metered.ca:443'
    ]
  }
]

let portcullisModulePromise = null

async function loadPortcullisModule() {
  if (portcullisModulePromise) return portcullisModulePromise
  portcullisModulePromise = import('@tostyssb/portcullis').catch((error) => {
    portcullisModulePromise = null
    throw error
  })
  return portcullisModulePromise
}

async function createWebRtcHost({ invite, rpc }) {
  const parsedInvite = new URL(invite)
  const relayUrl = parsedInvite.searchParams.get('relay') || 'ws://localhost:49443'

  const relaySocket = new WebSocket(relayUrl)
  await onceWebSocketOpen(relaySocket)
  let closed = false

  const dht = new DHT(new RelayStream(true, relaySocket))
  const portMappings = createPortMappingManager()
  const keyPair = DHT.keyPair ? DHT.keyPair(deriveStableSignalSeed(invite)) : dht.defaultKeyPair
  const server = dht.createServer()

  server.on('connection', (signalSocket) => {
    void handleSignalConnection(signalSocket, { invite, rpc, portMappings })
  })

  await server.listen(keyPair)

  const markClosed = () => {
    closed = true
  }
  relaySocket.addEventListener('close', markClosed, { once: true })
  relaySocket.addEventListener('error', markClosed, { once: true })

  const webLink = buildWebLink({
    signalKey: b4a.toString(keyPair.publicKey, 'hex'),
    relayUrl,
    invite
  })

  return {
    webLink,
    isAlive() {
      if (closed) return false
      return relaySocket.readyState === WebSocket.OPEN
    },
    async close() {
      closed = true
      try {
        await server.close()
      } catch {}
      try {
        await dht.destroy()
      } catch {}
      try {
        await portMappings.close()
      } catch {}
      try {
        relaySocket.close()
      } catch {}
    }
  }
}

function deriveStableSignalSeed(invite) {
  const value = String(invite || '').trim()
  return crypto.createHash('sha256').update('peardrop-webrtc-share-v1\0').update(value).digest()
}

function buildWebLink({ signalKey, relayUrl, invite }) {
  const url = new URL('peardrops-web://join')
  url.searchParams.set('signal', signalKey)
  url.searchParams.set('relay', relayUrl)
  url.searchParams.set('invite', invite)
  return url.toString()
}

async function handleSignalConnection(signalSocket, { invite, rpc, portMappings }) {
  const peer = createLinePeer(signalSocket)
  let pc = null
  let remoteDescriptionSet = false
  const pendingRemoteCandidates = []
  let handlingOffer = false
  let pendingOfferMessage = null
  let lastOfferSdp = ''
  let lastOfferId = 0
  let lastAnswerSdp = ''
  let lastAnsweredOfferId = 0
  let channelOpened = false
  let activePunchAtMs = 0
  let activeCandidateOfferId = 0
  let outgoingCandidateQueue = []
  let outgoingCandidateFlushTimer = null
  const localCandidateKinds = { host: 0, srflx: 0, prflx: 0, relay: 0, other: 0 }
  let remoteCandidatesReceived = 0
  let remoteCandidatesApplied = 0
  let remoteCandidatesQueued = 0
  let remoteAddCandidateErrors = 0
  let lastRemoteAddCandidateError = ''
  let activeOfferCandidateFlow = {
    offerId: 0,
    received: 0,
    queued: 0,
    applied: 0,
    addErrors: 0,
    lastAddError: ''
  }
  let lastHostNetStatusSentAt = 0

  let dataChannel = null
  let hostStatsTimer = null
  let lastHostIceStats = null

  const sendHostNetStatus = (force = false) => {
    const now = Date.now()
    if (!force && now - lastHostNetStatusSentAt < 350) return
    lastHostNetStatusSentAt = now
    peer.send({
      type: 'host-net-status',
      status: {
        hostNowMs: now,
        localCandidateKinds,
        upnp: portMappings.getStatus(),
        iceStats: lastHostIceStats,
        remoteCandidateFlow: {
          received: remoteCandidatesReceived,
          queued: remoteCandidatesQueued,
          applied: remoteCandidatesApplied,
          addErrors: remoteAddCandidateErrors,
          lastAddError: lastRemoteAddCandidateError
        },
        activeOfferCandidateFlow,
        offerState: {
          lastOfferId,
          lastAnsweredOfferId
        }
      }
    })
  }

  // Explicit signaling handshake so web peers can detect when host is truly listening.
  peer.send({
    type: 'ready',
    hostNowMs: Date.now(),
    punchAtMs: Date.now() + 900,
    hostNetStatus: {
      hostNowMs: Date.now(),
      localCandidateKinds,
      upnp: portMappings.getStatus(),
      iceStats: lastHostIceStats,
      remoteCandidateFlow: {
        received: remoteCandidatesReceived,
        queued: remoteCandidatesQueued,
        applied: remoteCandidatesApplied,
        addErrors: remoteAddCandidateErrors,
        lastAddError: lastRemoteAddCandidateError
      },
      activeOfferCandidateFlow,
      offerState: {
        lastOfferId,
        lastAnsweredOfferId
      }
    }
  })

  const addRemoteCandidate = async (candidate) => {
    if (!candidate) {
      await pc.addIceCandidate(null)
      return true
    }
    const candidateForAdd =
      typeof RTCIceCandidate === 'function' ? new RTCIceCandidate(candidate) : candidate
    await pc.addIceCandidate(candidateForAdd)
    return true
  }

  const flushPendingCandidates = async () => {
    if (!remoteDescriptionSet || pendingRemoteCandidates.length === 0) return
    while (pendingRemoteCandidates.length) {
      const candidate = pendingRemoteCandidates.shift()
      try {
        await addRemoteCandidate(candidate)
        if (candidate) remoteCandidatesApplied += 1
      } catch {}
    }
  }

  const destroyPeerConnection = () => {
    if (hostStatsTimer) {
      clearInterval(hostStatsTimer)
      hostStatsTimer = null
    }
    if (dataChannel && dataChannel.readyState !== 'closed') {
      try {
        dataChannel.close()
      } catch {}
    }
    dataChannel = null
    if (pc) {
      try {
        pc.onicecandidate = null
        pc.ondatachannel = null
        pc.close()
      } catch {}
      pc = null
    }
    remoteDescriptionSet = false
    pendingRemoteCandidates.length = 0
    channelOpened = false
    activePunchAtMs = 0
    activeCandidateOfferId = 0
    outgoingCandidateQueue = []
    if (outgoingCandidateFlushTimer) {
      clearTimeout(outgoingCandidateFlushTimer)
      outgoingCandidateFlushTimer = null
    }
  }

  const createPeerConnection = () => {
    destroyPeerConnection()
    const localPc = new RTCPeerConnection({
      iceServers: DEFAULT_ICE_SERVERS,
      iceCandidatePoolSize: 8
    })
    pc = localPc

    localPc.onicecandidate = (event) => {
      if (pc !== localPc) return
      if (event.candidate) {
        bumpCandidateKind(localCandidateKinds, event.candidate)
        if (isRelayIceCandidate(event.candidate)) return
        if (isMdnsIceCandidate(event.candidate)) return
        const localPort = parseHostUdpCandidatePort(event.candidate)
        if (localPort > 0) {
          void portMappings.mapUdpPort(localPort)
        }
        const normalized = normalizeCandidateForSignal(event.candidate)
        if (!normalized) return
        if (activePunchAtMs > Date.now()) {
          outgoingCandidateQueue.push({
            type: 'candidate',
            candidate: normalized,
            offerId: activeCandidateOfferId || undefined
          })
          return
        }
        peer.send({
          type: 'candidate',
          candidate: normalized,
          offerId: activeCandidateOfferId || undefined
        })
        sendHostNetStatus()
        return
      }
      if (activePunchAtMs > Date.now()) {
        outgoingCandidateQueue.push({
          type: 'candidate-end',
          endOfCandidates: true,
          offerId: activeCandidateOfferId || undefined
        })
        return
      }
      peer.send({
        type: 'candidate-end',
        endOfCandidates: true,
        offerId: activeCandidateOfferId || undefined
      })
      sendHostNetStatus()
    }

    localPc.oniceconnectionstatechange = () => {
      if (pc !== localPc) return
      peer.send({
        type: 'host-ice-state',
        state: String(localPc.iceConnectionState || '')
      })
      sendHostIceStats()
      sendHostNetStatus()
    }
    localPc.onconnectionstatechange = () => {
      if (pc !== localPc) return
      peer.send({
        type: 'host-conn-state',
        state: String(localPc.connectionState || '')
      })
      sendHostIceStats()
      sendHostNetStatus()
    }

    localPc.ondatachannel = (event) => {
      if (pc !== localPc) return
      dataChannel = event.channel
      dataChannel.onopen = () => {
        channelOpened = true
      }
      dataChannel.onclose = () => {
        channelOpened = false
      }
      bindDataChannel(dataChannel, { invite, rpc })
    }

    const sendHostIceStats = () => {
      void collectIceStatsSummary(localPc)
        .then((summary) => {
          if (!summary) return
          lastHostIceStats = summary
          peer.send({ type: 'host-ice-stats', stats: summary })
        })
        .catch(() => {})
    }

    hostStatsTimer = setInterval(() => {
      if (pc !== localPc) return
      sendHostIceStats()
    }, 1000)
    if (typeof hostStatsTimer?.unref === 'function') hostStatsTimer.unref()
    sendHostIceStats()
  }

  createPeerConnection()

  const handleOfferMessage = async (message) => {
      const incomingOfferSdp = sanitizeIceSdp(String(message.sdp || ''))
      const incomingOfferId = Number(message.offerId || 0)
      if (incomingOfferId > 0) {
        activeCandidateOfferId = incomingOfferId
        activeOfferCandidateFlow = {
          offerId: incomingOfferId,
          received: 0,
          queued: 0,
          applied: 0,
          addErrors: 0,
          lastAddError: ''
        }
      }
      if (incomingOfferId > 0) {
        peer.send({ type: 'offer-ack', offerId: incomingOfferId, stage: 'received' })
      }
      if (handlingOffer) {
        // Keep only the freshest pending offer while a prior one is being processed.
        pendingOfferMessage = message
        if (incomingOfferId > 0) {
          peer.send({ type: 'offer-ack', offerId: incomingOfferId, stage: 'queued' })
        }
        return
      }

      // Web sender may re-send the same offer for reliability.
      // If we've already answered this SDP, just repeat the cached answer.
      if (lastAnswerSdp && incomingOfferSdp && incomingOfferSdp === lastOfferSdp) {
        if (incomingOfferId > 0) {
          peer.send({ type: 'offer-ack', offerId: incomingOfferId, stage: 'reuse-answer' })
        }
        peer.send({ type: 'answer', sdp: lastAnswerSdp, offerId: incomingOfferId || lastOfferId || undefined })
        return
      }
      if (channelOpened && lastAnswerSdp) {
        if (incomingOfferId > 0) {
          peer.send({ type: 'offer-ack', offerId: incomingOfferId, stage: 'channel-open' })
        }
        peer.send({ type: 'answer', sdp: lastAnswerSdp, offerId: incomingOfferId || lastOfferId || undefined })
        return
      }

      const isNewOfferGeneration = incomingOfferSdp && incomingOfferSdp !== lastOfferSdp
      const iceState = String(pc?.iceConnectionState || '')
      const connState = String(pc?.connectionState || '')
      const shouldResetForNewOffer =
        isNewOfferGeneration &&
        !channelOpened &&
        (!pc || iceState === 'failed' || iceState === 'closed' || connState === 'failed' || connState === 'closed')
      if (shouldResetForNewOffer) {
        lastAnswerSdp = ''
        createPeerConnection()
      }
      if (isNewOfferGeneration) {
        // New offer generation: queue incoming candidates until the matching offer is applied.
        remoteDescriptionSet = false
        pendingRemoteCandidates.length = 0
      }
      const requestedPunchAtMs = normalizePunchAtMs(message.punchAtMs, Date.now())
      activePunchAtMs = requestedPunchAtMs
      scheduleOutgoingCandidateFlush()
      handlingOffer = true
      if (incomingOfferId > 0) {
        peer.send({ type: 'offer-ack', offerId: incomingOfferId, stage: 'processing' })
      }
      await waitUntilPunchAt(activePunchAtMs)

      // Ignore unexpected offer states instead of crashing negotiation with invalid transitions.
      if (String(pc.signalingState || '') !== 'stable') {
        handlingOffer = false
        if (incomingOfferId > 0) {
          peer.send({
            type: 'offer-ack',
            offerId: incomingOfferId,
            stage: 'deferred-nonstable',
            signalingState: String(pc.signalingState || '')
          })
        }
        if (lastAnswerSdp) {
          peer.send({ type: 'answer', sdp: lastAnswerSdp, offerId: incomingOfferId || lastOfferId || undefined })
        }
        const nextOffer = pendingOfferMessage
        pendingOfferMessage = null
        if (nextOffer) void handleOfferMessage(nextOffer)
        return
      }

      try {
        await pc.setRemoteDescription({
          type: 'offer',
          sdp: incomingOfferSdp
        })
        remoteDescriptionSet = true
        await flushPendingCandidates()
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        const sdp = sanitizeIceSdp(String(answer.sdp || ''))
        lastOfferSdp = incomingOfferSdp
        lastOfferId = incomingOfferId
        lastAnswerSdp = sdp
        if (incomingOfferId > 0) {
          activeCandidateOfferId = incomingOfferId
        }
        peer.send({
          type: 'answer',
          sdp,
          offerId: incomingOfferId || undefined
        })
        lastAnsweredOfferId = incomingOfferId
        if (incomingOfferId > 0) {
          peer.send({ type: 'offer-ack', offerId: incomingOfferId, stage: 'answered' })
        }
      } catch (error) {
        peer.send({
          type: 'error',
          error: error?.message || String(error)
        })
        if (incomingOfferId > 0) {
          peer.send({
            type: 'offer-ack',
            offerId: incomingOfferId,
            stage: 'error',
            error: String(error?.message || error || '')
          })
        }
      } finally {
        handlingOffer = false
        const nextOffer = pendingOfferMessage
        pendingOfferMessage = null
        if (nextOffer) void handleOfferMessage(nextOffer)
      }
      return
  }

  peer.onMessage(async (message) => {
    if (message.type === 'offer' && message.sdp) {
      await handleOfferMessage(message)
      return
    }

    if (message.type === 'candidate' && message.candidate) {
      const normalized = normalizeCandidateForSignal(message.candidate)
      if (!normalized) return
      const candidateOfferId = Number(message.offerId || 0)
      if (
        candidateOfferId > 0 &&
        activeCandidateOfferId > 0 &&
        candidateOfferId !== activeCandidateOfferId
      ) {
        return
      }
      remoteCandidatesReceived += 1
      if (activeOfferCandidateFlow.offerId === activeCandidateOfferId) {
        activeOfferCandidateFlow.received += 1
      }
      if (isRelayIceCandidate(normalized)) return
      if (isMdnsIceCandidate(normalized)) return
      if (!remoteDescriptionSet) {
        remoteCandidatesQueued += 1
        if (activeOfferCandidateFlow.offerId === activeCandidateOfferId) {
          activeOfferCandidateFlow.queued += 1
        }
        pendingRemoteCandidates.push(normalized)
        return
      }
      try {
        const candidateForAdd =
          typeof RTCIceCandidate === 'function' ? new RTCIceCandidate(normalized) : normalized
        await pc.addIceCandidate(candidateForAdd)
        remoteCandidatesApplied += 1
        if (activeOfferCandidateFlow.offerId === activeCandidateOfferId) {
          activeOfferCandidateFlow.applied += 1
        }
      } catch (error) {
        remoteAddCandidateErrors += 1
        lastRemoteAddCandidateError = String(error?.message || error || '')
        if (activeOfferCandidateFlow.offerId === activeCandidateOfferId) {
          activeOfferCandidateFlow.addErrors += 1
          activeOfferCandidateFlow.lastAddError = String(error?.message || error || '')
        }
        peer.send({
          type: 'error',
          error: `Host addIceCandidate failed: ${String(error?.message || error || '')}`
        })
      }
      return
    }

    if (message.type === 'candidate-end' || message.endOfCandidates === true) {
      const candidateOfferId = Number(message.offerId || 0)
      if (
        candidateOfferId > 0 &&
        activeCandidateOfferId > 0 &&
        candidateOfferId !== activeCandidateOfferId
      ) {
        return
      }
      if (!remoteDescriptionSet) {
        pendingRemoteCandidates.push(null)
        return
      }
      try {
        await addRemoteCandidate(null)
      } catch {}
    }
  })

  signalSocket.on('close', () => {
    destroyPeerConnection()
  })

  function scheduleOutgoingCandidateFlush() {
    if (outgoingCandidateFlushTimer) {
      clearTimeout(outgoingCandidateFlushTimer)
      outgoingCandidateFlushTimer = null
    }
    const flush = () => {
      const pending = outgoingCandidateQueue
      outgoingCandidateQueue = []
      for (const item of pending) {
        peer.send(item)
      }
      sendHostNetStatus()
    }
    const delayMs = Math.max(0, Number(activePunchAtMs || 0) - Date.now())
    if (delayMs <= 0) {
      flush()
      return
    }
    outgoingCandidateFlushTimer = setTimeout(() => {
      outgoingCandidateFlushTimer = null
      flush()
    }, delayMs)
  }
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

function isRelayIceCandidate(candidateLike) {
  const candidateLine =
    typeof candidateLike === 'string'
      ? candidateLike
      : String(candidateLike?.candidate || '')
  return /\btyp\s+relay\b/i.test(candidateLine)
}

function isMdnsIceCandidate(candidateLike) {
  const candidateLine =
    typeof candidateLike === 'string'
      ? candidateLike
      : String(candidateLike?.candidate || '')
  return /\b[a-z0-9-]+\.local\b/i.test(candidateLine)
}

function parseHostUdpCandidatePort(candidateLike) {
  const line =
    typeof candidateLike === 'string' ? candidateLike : String(candidateLike?.candidate || '')
  const match = line.match(/\bcandidate:[^\s]+\s+\d+\s+udp\s+\d+\s+[^\s]+\s+(\d+)\s+typ\s+host\b/i)
  if (!match) return 0
  const port = Number.parseInt(match[1], 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return 0
  return port
}

function sanitizeIceSdp(sdpText) {
  const raw = String(sdpText || '')
  if (!raw) return raw
  const lines = raw.split(/\r?\n/)
  const out = []
  for (const line of lines) {
    const value = String(line || '')
    if (!value) {
      out.push(value)
      continue
    }
    if (value.startsWith('a=candidate:')) {
      if (isRelayIceCandidate(value)) continue
      if (isMdnsIceCandidate(value)) continue
    }
    out.push(value)
  }
  return out.join('\r\n')
}

function createPortMappingManager() {
  const legacyUpnpClient = natUpnp.createClient()
  const mappedPorts = new Set()
  const mappedPortMeta = new Map()
  const inflight = new Map()
  let attempts = 0
  let succeeded = 0
  let failed = 0
  let refreshes = 0
  let lastError = ''
  let closed = false
  let refreshTimer = null
  let detectedGateway = ''
  let gatewayDetectAttempts = 0
  let gatewayDetectFailures = 0
  let gatewayLastError = ''
  let lastMappedVia = ''
  const protocolStats = {
    pcp: { attempts: 0, succeeded: 0, failed: 0, lastError: '' },
    natPmp: { attempts: 0, succeeded: 0, failed: 0, lastError: '' },
    upnp: { attempts: 0, succeeded: 0, failed: 0, lastError: '' },
    upnpLegacy: { attempts: 0, succeeded: 0, failed: 0, lastError: '' }
  }
  const protocolClients = {
    pcp: null,
    natPmp: null,
    upnp: null
  }
  const protocolClientInit = {
    pcp: null,
    natPmp: null,
    upnp: null
  }
  let portcullis = null

  const withTimeout = (promise, timeoutMs = 8000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('NAT mapping timeout')), timeoutMs)
      Promise.resolve(promise)
        .then((value) => {
          clearTimeout(timer)
          resolve(value)
        })
        .catch((error) => {
          clearTimeout(timer)
          reject(error)
        })
    })

  const normalizeError = (error, fallback = 'mapping error') =>
    String(error?.message || error || fallback)

  const loadPortcullis = async () => {
    if (portcullis) return portcullis
    const mod = await loadPortcullisModule()
    portcullis = mod || null
    return portcullis
  }

  const detectGateway = async () => {
    if (detectedGateway) return detectedGateway
    gatewayDetectAttempts += 1
    try {
      const mod = await loadPortcullis()
      const gateway = await withTimeout(mod.detectGateway(), 3000)
      detectedGateway = String(gateway || '')
      gatewayLastError = ''
      return detectedGateway
    } catch (error) {
      gatewayDetectFailures += 1
      gatewayLastError = normalizeError(error, 'gateway detect failed')
      throw error
    }
  }

  const getProtocolClient = async (protocol) => {
    if (protocolClients[protocol]) return protocolClients[protocol]
    if (protocolClientInit[protocol]) return protocolClientInit[protocol]
    const initTask = (async () => {
      const mod = await loadPortcullis()
      const gateway = await detectGateway()
      if (!gateway) throw new Error('No gateway discovered')
      let client = null
      if (protocol === 'pcp') {
        client = await withTimeout(mod.createPcpClient(gateway), 3000)
      } else if (protocol === 'natPmp') {
        client = await withTimeout(mod.createPmpClient(gateway), 3000)
      } else if (protocol === 'upnp') {
        client = await withTimeout(mod.createUpnpClient(gateway), 3000)
      }
      if (!client) throw new Error(`No ${protocol} client available`)
      protocolClients[protocol] = client
      return client
    })()
      .finally(() => {
        protocolClientInit[protocol] = null
      })
    protocolClientInit[protocol] = initTask
    return initTask
  }

  const tryProtocolMap = async (protocol, port) => {
    const stats = protocolStats[protocol]
    stats.attempts += 1
    try {
      const client = await getProtocolClient(protocol)
      const result = await withTimeout(
        client.map({
          publicPort: port,
          privatePort: port,
          protocol: 'udp',
          ttl: 60 * 30,
          description: 'PearDrop WebRTC'
        }),
        8000
      )
      mappedPorts.add(port)
      mappedPortMeta.set(port, {
        protocol,
        natProtocol: String(result?.natProtocol || protocol),
        publicPort: Number(result?.publicPort || port),
        privatePort: Number(result?.privatePort || port),
        ttl: Number(result?.ttl || 60 * 30),
        mappedAt: Date.now()
      })
      stats.succeeded += 1
      stats.lastError = ''
      lastMappedVia = String(result?.natProtocol || protocol)
      return true
    } catch (error) {
      stats.failed += 1
      stats.lastError = normalizeError(error, `${protocol} map failed`)
      return false
    }
  }

  const tryLegacyUpnpMap = async (port) => {
    const stats = protocolStats.upnpLegacy
    stats.attempts += 1
    try {
      const success = await withTimeout(
        new Promise((resolve) => {
          legacyUpnpClient.portMapping(
            {
              public: port,
              private: port,
              protocol: 'UDP',
              ttl: 60 * 30,
              description: 'PearDrop WebRTC'
            },
            (error) => resolve(!error)
          )
        }),
        8000
      )
      if (!success) {
        stats.failed += 1
        stats.lastError = 'legacy upnp map failed'
        return false
      }
      mappedPorts.add(port)
      mappedPortMeta.set(port, {
        protocol: 'upnpLegacy',
        natProtocol: 'upnp',
        publicPort: port,
        privatePort: port,
        ttl: 60 * 30,
        mappedAt: Date.now()
      })
      stats.succeeded += 1
      stats.lastError = ''
      lastMappedVia = 'upnp-legacy'
      return true
    } catch (error) {
      stats.failed += 1
      stats.lastError = normalizeError(error, 'legacy upnp map timeout')
      return false
    }
  }

  const performMapping = async (port, { refresh = false } = {}) => {
    if (closed) return false
    if (!refresh && mappedPorts.has(port)) return true
    if (inflight.has(port)) return inflight.get(port)
    attempts += 1
    if (refresh) refreshes += 1

    const task = (async () => {
      let ok = false
      ok = await tryProtocolMap('pcp', port)
      if (!ok) ok = await tryProtocolMap('natPmp', port)
      if (!ok) ok = await tryProtocolMap('upnp', port)
      if (!ok) ok = await tryLegacyUpnpMap(port)
      if (ok) {
        succeeded += 1
        lastError = ''
        return true
      }
      failed += 1
      const lastProtocolError =
        protocolStats.pcp.lastError ||
        protocolStats.natPmp.lastError ||
        protocolStats.upnp.lastError ||
        protocolStats.upnpLegacy.lastError ||
        'port mapping failed'
      lastError = String(lastProtocolError)
      return false
    })()
      .finally(() => {
        inflight.delete(port)
      })

    inflight.set(port, task)
    return task
  }

  const mapUdpPort = async (port) => performMapping(port, { refresh: false })

  const ensureRefreshTimer = () => {
    if (refreshTimer) return
    refreshTimer = setInterval(() => {
      if (closed) return
      if (mappedPorts.size === 0) return
      for (const port of mappedPorts) {
        void performMapping(port, { refresh: true })
      }
    }, 25000)
    if (typeof refreshTimer?.unref === 'function') refreshTimer.unref()
  }

  ensureRefreshTimer()

  const close = async () => {
    if (closed) return
    closed = true
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
    await Promise.all(
      Array.from(mappedPorts).map(async (port) => {
        const meta = mappedPortMeta.get(port) || {}
        const protocol = String(meta.protocol || '')
        const publicPort = Number(meta.publicPort || port)
        if (protocol === 'upnpLegacy') {
          await new Promise((resolve) => {
            legacyUpnpClient.portUnmapping({ public: publicPort, protocol: 'UDP' }, () => resolve())
          })
          return
        }
        const client = protocolClients[protocol]
        if (!client || typeof client.unmap !== 'function') return
        try {
          await withTimeout(client.unmap({ publicPort, protocol: 'udp' }), 3000)
        } catch {}
      })
    )
    mappedPorts.clear()
    mappedPortMeta.clear()
    for (const protocol of ['pcp', 'natPmp', 'upnp']) {
      const client = protocolClients[protocol]
      if (client && typeof client.close === 'function') {
        try {
          // eslint-disable-next-line no-await-in-loop
          await client.close()
        } catch {}
      }
      protocolClients[protocol] = null
      protocolClientInit[protocol] = null
    }
    try {
      legacyUpnpClient.close()
    } catch {}
  }

  return {
    mapUdpPort,
    close,
    getStatus() {
      return {
        attempts,
        succeeded,
        failed,
        refreshes,
        mappedPorts: Array.from(mappedPorts).sort((a, b) => a - b),
        mappedPortMeta: Array.from(mappedPortMeta.entries())
          .map(([port, meta]) => ({ port, ...meta }))
          .sort((a, b) => a.port - b.port),
        inflight: inflight.size,
        lastError,
        lastMappedVia,
        gateway: {
          address: detectedGateway,
          detectAttempts: gatewayDetectAttempts,
          detectFailures: gatewayDetectFailures,
          lastError: gatewayLastError
        },
        protocols: {
          pcp: protocolStats.pcp,
          natPmp: protocolStats.natPmp,
          upnp: protocolStats.upnp,
          upnpLegacy: protocolStats.upnpLegacy
        }
      }
    }
  }
}

function normalizeCandidateForSignal(candidateLike) {
  const source =
    candidateLike && typeof candidateLike === 'object' && typeof candidateLike.toJSON === 'function'
      ? candidateLike.toJSON()
      : candidateLike
  const candidate = String(source?.candidate || '')
  if (!candidate) return null
  const sdpMid =
    source?.sdpMid === null || typeof source?.sdpMid === 'string' ? source.sdpMid : null
  const sdpMLineIndex = Number.isInteger(source?.sdpMLineIndex)
    ? Number(source.sdpMLineIndex)
    : 0
  const usernameFragment =
    typeof source?.usernameFragment === 'string' && source.usernameFragment
      ? source.usernameFragment
      : parseUfragFromCandidateLine(candidate)
  const normalized = { candidate, sdpMid, sdpMLineIndex }
  if (usernameFragment) normalized.usernameFragment = usernameFragment
  return normalized
}

function normalizePunchAtMs(rawValue, nowMs = Date.now()) {
  const value = Number(rawValue || 0)
  const earliest = Number(nowMs || Date.now()) + 150
  const latest = Number(nowMs || Date.now()) + 10000
  if (!Number.isFinite(value) || value <= 0) return earliest
  return Math.max(earliest, Math.min(latest, value))
}

function waitUntilPunchAt(targetMs) {
  const waitMs = Math.max(0, Number(targetMs || 0) - Date.now())
  if (waitMs <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, waitMs))
}

function parseUfragFromCandidateLine(line) {
  const text = String(line || '')
  if (!text) return undefined
  const match = text.match(/\bufrag\s+([^\s]+)/i)
  if (!match) return undefined
  return String(match[1] || '').trim() || undefined
}

function bumpCandidateKind(counter, candidateLike) {
  if (!counter) return
  const kind = parseCandidateKind(candidateLike)
  if (!Object.hasOwn(counter, kind)) counter[kind] = 0
  counter[kind] += 1
}

async function collectIceStatsSummary(pc) {
  if (!pc || typeof pc.getStats !== 'function') return null
  const report = await pc.getStats()
  const summary = {
    selectedPair: null,
    candidatePairs: { total: 0, succeeded: 0, failed: 0, inProgress: 0 },
    localCandidates: { total: 0, byType: {} },
    remoteCandidates: { total: 0, byType: {} }
  }
  const byId = new Map()
  for (const stat of report.values()) byId.set(stat.id, stat)
  for (const stat of report.values()) {
    if (stat.type === 'candidate-pair') {
      summary.candidatePairs.total += 1
      const state = String(stat.state || '')
      if (state === 'succeeded') summary.candidatePairs.succeeded += 1
      else if (state === 'failed') summary.candidatePairs.failed += 1
      else summary.candidatePairs.inProgress += 1
      if (stat.nominated || stat.selected) {
        const local = byId.get(stat.localCandidateId)
        const remote = byId.get(stat.remoteCandidateId)
        summary.selectedPair = {
          state,
          nominated: Boolean(stat.nominated),
          bytesSent: Number(stat.bytesSent || 0),
          bytesReceived: Number(stat.bytesReceived || 0),
          currentRoundTripTime: Number(stat.currentRoundTripTime || 0),
          local: local
            ? {
                candidateType: String(local.candidateType || ''),
                protocol: String(local.protocol || ''),
                address: String(local.address || ''),
                port: Number(local.port || 0)
              }
            : null,
          remote: remote
            ? {
                candidateType: String(remote.candidateType || ''),
                protocol: String(remote.protocol || ''),
                address: String(remote.address || ''),
                port: Number(remote.port || 0)
              }
            : null
        }
      }
      continue
    }
    if (stat.type === 'local-candidate') {
      summary.localCandidates.total += 1
      const kind = String(stat.candidateType || 'other')
      summary.localCandidates.byType[kind] = Number(summary.localCandidates.byType[kind] || 0) + 1
      continue
    }
    if (stat.type === 'remote-candidate') {
      summary.remoteCandidates.total += 1
      const kind = String(stat.candidateType || 'other')
      summary.remoteCandidates.byType[kind] = Number(summary.remoteCandidates.byType[kind] || 0) + 1
    }
  }
  return summary
}

function parseCandidateKind(candidateLike) {
  const line =
    typeof candidateLike === 'string'
      ? candidateLike
      : String(candidateLike?.candidate || '')
  if (!line) return 'other'
  const match = line.match(/\btyp\s+(host|srflx|prflx|relay)\b/i)
  return match ? String(match[1] || '').toLowerCase() : 'other'
}

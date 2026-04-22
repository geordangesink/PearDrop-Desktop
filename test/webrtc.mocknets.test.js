const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const b4a = require('b4a')

const PROFILE_CONNECTABLE = {
  localTrickleCandidates: [
    'candidate:1 1 udp 2122260223 10.0.0.2 51234 typ host',
    'candidate:2 1 udp 1686052607 198.51.100.25 42311 typ srflx raddr 10.0.0.2 rport 51234'
  ],
  remoteSdpCandidates: [
    'candidate:3 1 udp 2122260223 10.0.1.3 50000 typ host',
    'candidate:4 1 udp 1686052607 203.0.113.18 41000 typ srflx raddr 10.0.1.3 rport 50000'
  ],
  remoteTrickleCandidates: [
    'candidate:5 1 udp 2122260223 10.0.1.4 50001 typ host',
    'candidate:6 1 udp 1686052607 203.0.113.19 41001 typ srflx raddr 10.0.1.4 rport 50001'
  ],
  connectAfterAnswer: true
}

const PROFILE_BLOCKED_DIRECT = {
  localTrickleCandidates: [
    'candidate:11 1 udp 2122260223 10.0.0.2 51234 typ host',
    'candidate:12 1 udp 2122260223 10.0.0.2.local 51235 typ host'
  ],
  remoteSdpCandidates: ['candidate:13 1 udp 2122260223 10.0.1.3 50000 typ host'],
  remoteTrickleCandidates: ['candidate:14 1 udp 2122260223 10.0.1.4 50001 typ host'],
  connectAfterAnswer: false
}

const PROFILE_STUCK_AFTER_ANSWER = {
  localTrickleCandidates: [
    'candidate:21 1 udp 2122260223 10.0.0.2 51234 typ host',
    'candidate:22 1 udp 1686052607 198.51.100.25 42311 typ srflx raddr 10.0.0.2 rport 51234'
  ],
  remoteSdpCandidates: [
    'candidate:23 1 udp 2122260223 10.0.1.3 50000 typ host',
    'candidate:24 1 udp 1686052607 203.0.113.18 41000 typ srflx raddr 10.0.1.3 rport 50000'
  ],
  remoteTrickleCandidates: [
    'candidate:25 1 udp 2122260223 10.0.1.4 50001 typ host',
    'candidate:26 1 udp 1686052607 203.0.113.19 41001 typ srflx raddr 10.0.1.4 rport 50001'
  ],
  connectAfterAnswer: false
}

test('mock net profile: desktop host <-> browser join succeeds when srflx exists', async () => {
  const { openDriveViaWebRtcInvite } = await importWebRtcClient()
  await withMockRtcEnvironment(PROFILE_CONNECTABLE, async (context) => {
    const session = await openDriveViaWebRtcInvite(
      { signalKey: 'ab'.repeat(32), nativeInvite: 'peardrops://invite?room=abc' },
      'wss://relay.example.test',
      {
        DHT: makeMockDhtClass(context),
        RelayStream: class MockRelayStream {},
        b4a
      }
    )

    const rawManifest = await session.drive.get('/manifest.json')
    const manifest = JSON.parse(b4a.toString(rawManifest, 'utf8'))
    assert.equal(Array.isArray(manifest.files), true)
    assert.equal(manifest.files.length, 1)
    assert.equal(manifest.files[0].name, 'mock.txt')
    await session.close()
  })
})

test('mock net profile: browser join fails fast when no reflexive candidates exist', async () => {
  const { openDriveViaWebRtcInvite } = await importWebRtcClient()
  await withMockRtcEnvironment(PROFILE_BLOCKED_DIRECT, async (context) => {
    await assert.rejects(
      () =>
        openDriveViaWebRtcInvite(
          { signalKey: 'cd'.repeat(32), nativeInvite: 'peardrops://invite?room=abc' },
          'wss://relay.example.test',
          {
            DHT: makeMockDhtClass(context),
            RelayStream: class MockRelayStream {},
            b4a
          }
        ),
      /No reflexive ICE candidates available for direct cross-network route/
    )
  })
})

test('mock net profile: browser does not renegotiate churn after answer when ICE stays checking', async () => {
  const { openDriveViaWebRtcInvite } = await importWebRtcClient()
  await withMockRtcEnvironment(PROFILE_STUCK_AFTER_ANSWER, async (context) => {
    await assert.rejects(
      () =>
        openDriveViaWebRtcInvite(
          { signalKey: 'ef'.repeat(32), nativeInvite: 'peardrops://invite?room=abc' },
          'wss://relay.example.test',
          {
            DHT: makeMockDhtClass(context),
            RelayStream: class MockRelayStream {},
            b4a
          },
          {
            timing: {
              noAnswerTimeoutMs: 1200,
              handshakeTimeoutMs: 3000,
              postAnswerConnectTimeoutMs: 1800,
              postAnswerIdleTimeoutMs: 500
            }
          }
        ),
      /Timed out waiting for ICE connect after peer answer|Timed out waiting for direct WebRTC channel/
    )
    assert.equal(context.offerCount, 2)
  })
})

async function importWebRtcClient() {
  const url = pathToFileUrl(
    path.resolve(__dirname, '..', '..', 'web', 'src', 'lib', 'webrtc-client.js')
  )
  return import(url)
}

function pathToFileUrl(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/')
  return `file://${normalized}`
}

async function withMockRtcEnvironment(profile, fn) {
  const previousWebSocket = globalThis.WebSocket
  const previousRtcPeer = globalThis.RTCPeerConnection
  const context = {
    profile,
    activePc: null,
    signalSocket: null,
    offerCount: 0
  }

  class MockWebSocket {
    constructor(url) {
      this.url = url
      this.readyState = MockWebSocket.CONNECTING
      this._listeners = new Map()
      setImmediate(() => {
        this.readyState = MockWebSocket.OPEN
        this._emit('open')
      })
    }
    addEventListener(name, listener, options = {}) {
      const once = Boolean(options?.once)
      const wrapped = once
        ? (...args) => {
            this.removeEventListener(name, wrapped)
            listener(...args)
          }
        : listener
      if (!this._listeners.has(name)) this._listeners.set(name, new Set())
      this._listeners.get(name).add(wrapped)
    }
    removeEventListener(name, listener) {
      this._listeners.get(name)?.delete(listener)
    }
    close() {
      this.readyState = MockWebSocket.CLOSED
      this._emit('close')
    }
    _emit(name, ...args) {
      const set = this._listeners.get(name)
      if (!set) return
      for (const listener of set) listener(...args)
    }
  }
  MockWebSocket.CONNECTING = 0
  MockWebSocket.OPEN = 1
  MockWebSocket.CLOSED = 3

  class MockDataChannel {
    constructor() {
      this.readyState = 'connecting'
      this.onopen = null
      this.onerror = null
      this.onmessage = null
    }
    send(payload) {
      const request = JSON.parse(String(payload || '{}'))
      const id = Number(request.id || 0)
      let response = { id, ok: true }
      if (request.type === 'manifest') {
        response = {
          id,
          ok: true,
          manifest: { files: [{ name: 'mock.txt', drivePath: '/files/mock.txt', byteLength: 4 }] }
        }
      } else if (request.type === 'file' || request.type === 'file-chunk') {
        response = { id, ok: true, dataBase64: b4a.toString(b4a.from('mock'), 'base64') }
      }
      setImmediate(() => {
        if (typeof this.onmessage === 'function') {
          this.onmessage({ data: JSON.stringify(response) })
        }
      })
    }
    close() {
      this.readyState = 'closed'
    }
    _open() {
      this.readyState = 'open'
      if (typeof this.onopen === 'function') this.onopen()
    }
  }

  class MockRTCPeerConnection {
    constructor() {
      this.connectionState = 'new'
      this.iceConnectionState = 'new'
      this.iceGatheringState = 'new'
      this.signalingState = 'stable'
      this.onicecandidate = null
      this.oniceconnectionstatechange = null
      this.onconnectionstatechange = null
      this._listeners = new Map()
      this._channel = null
      context.activePc = this
    }
    createDataChannel() {
      this._channel = new MockDataChannel()
      return this._channel
    }
    async createOffer() {
      return {
        type: 'offer',
        sdp: toSdpLines(context.profile.localTrickleCandidates)
      }
    }
    async setLocalDescription(desc) {
      this.localDescription = desc
      this.signalingState = 'have-local-offer'
      this.iceGatheringState = 'gathering'
      for (const candidate of context.profile.localTrickleCandidates) {
        if (typeof this.onicecandidate === 'function') {
          this.onicecandidate({ candidate: { candidate } })
        }
      }
      this.iceGatheringState = 'complete'
    }
    async setRemoteDescription(desc) {
      this.remoteDescription = desc
      this.signalingState = 'stable'
      this.iceConnectionState = 'checking'
      this.connectionState = 'connecting'
      this._dispatchConnectionEvents()
      if (context.profile.connectAfterAnswer) {
        setTimeout(() => {
          this.iceConnectionState = 'connected'
          this.connectionState = 'connected'
          this._dispatchConnectionEvents()
          this._channel?._open()
        }, 15)
      }
    }
    async addIceCandidate(_candidate) {}
    addEventListener(name, listener) {
      if (!this._listeners.has(name)) this._listeners.set(name, new Set())
      this._listeners.get(name).add(listener)
    }
    removeEventListener(name, listener) {
      this._listeners.get(name)?.delete(listener)
    }
    close() {
      this.connectionState = 'closed'
      this.iceConnectionState = 'closed'
      this._dispatchConnectionEvents()
    }
    _dispatchConnectionEvents() {
      if (typeof this.oniceconnectionstatechange === 'function') this.oniceconnectionstatechange()
      if (typeof this.onconnectionstatechange === 'function') this.onconnectionstatechange()
      for (const listener of this._listeners.get('connectionstatechange') || []) listener()
    }
  }

  globalThis.WebSocket = MockWebSocket
  globalThis.RTCPeerConnection = MockRTCPeerConnection

  try {
    await fn(context)
  } finally {
    globalThis.WebSocket = previousWebSocket
    globalThis.RTCPeerConnection = previousRtcPeer
  }
}

function makeMockDhtClass(context) {
  return class MockDht {
    constructor() {}
    connect() {
      const socket = createMockSignalSocket(context)
      context.signalSocket = socket
      return socket
    }
    async destroy() {}
  }
}

function createMockSignalSocket(context) {
  const listeners = new Map()
  let destroyed = false
  const emit = (name, value) => {
    for (const listener of listeners.get(name) || []) listener(value)
  }
  const sendMessage = (message) => {
    emit('data', b4a.from(`${JSON.stringify(message)}\n`, 'utf8'))
  }

  setImmediate(() => {
    if (destroyed) return
    emit('open')
    sendMessage({ type: 'ready' })
  })

  return {
    opened: true,
    writable: true,
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener)
    },
    off(name, listener) {
      listeners.get(name)?.delete(listener)
    },
    write(buffer) {
      const raw = b4a.toString(buffer, 'utf8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let message = null
        try {
          message = JSON.parse(trimmed)
        } catch {
          continue
        }
        if (message.type === 'offer') {
          context.offerCount += 1
          setImmediate(() => {
            sendMessage({
              type: 'answer',
              sdp: toSdpLines(context.profile.remoteSdpCandidates || [])
            })
            for (const candidate of context.profile.remoteTrickleCandidates || []) {
              sendMessage({ type: 'candidate', candidate: { candidate } })
            }
          })
        }
      }
      return true
    },
    destroy() {
      destroyed = true
      emit('close')
    }
  }
}

function toSdpLines(candidates) {
  const lines = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel'
  ]
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    lines.push(`a=${String(candidate)}`)
  }
  return `${lines.join('\r\n')}\r\n`
}

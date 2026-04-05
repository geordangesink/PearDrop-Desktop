function normalizeBuffer(data) {
  if (Buffer.isBuffer(data)) return data
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  if (data && data.type === 'Buffer' && Array.isArray(data.data)) {
    return Buffer.from(data.data)
  }
  if (Array.isArray(data)) return Buffer.from(data)
  if (typeof data === 'string') return Buffer.from(data)
  return Buffer.from([])
}

module.exports = {
  normalizeBuffer
}

function isDeepLink(url, protocol = 'peardrops') {
  return typeof url === 'string' && url.startsWith(`${protocol}://`)
}

function findDeepLink(args = [], protocol = 'peardrops') {
  return args.find((arg) => isDeepLink(arg, protocol)) || null
}

module.exports = {
  isDeepLink,
  findDeepLink
}

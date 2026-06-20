const webpack = require('webpack')

config.plugins.push(
  new webpack.NormalModuleReplacementPlugin(/^node:(net|tls|fs|dns)$/, (resource) => {
    resource.request = resource.request.replace(/^node:/, '')
  }),
)

config.resolve = config.resolve || {}
config.resolve.fallback = {
  ...(config.resolve.fallback || {}),
  net: false,
  tls: false,
  fs: false,
  dns: false,
}

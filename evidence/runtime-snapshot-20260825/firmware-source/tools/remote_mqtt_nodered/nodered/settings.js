const httpUser = process.env.CLOUD_HTTP_USER;
const httpPasswordHash = process.env.CLOUD_HTTP_PASSWORD_HASH;
const httpAuth = httpUser && httpPasswordHash ? {
  user: httpUser,
  pass: httpPasswordHash,
} : undefined;

module.exports = {
  uiPort: process.env.PORT || 1880,
  flowFile: 'flows.json',
  credentialSecret: process.env.NODE_RED_CREDENTIAL_SECRET || 'wireless-debug-node-red',
  httpStatic: '/data/public',
  httpStaticAuth: httpAuth,
  httpNodeAuth: httpAuth,
  functionExternalModules: false,
  functionGlobalContext: {
    pg: require('pg'),
    crypto: require('crypto'),
  },
  logging: {
    console: {
      level: 'info',
      metrics: false,
      audit: false,
    },
  },
};

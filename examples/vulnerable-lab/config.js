'use strict'

module.exports = {
  host: '127.0.0.1',
  port: Number(process.env.LAB_PORT || 4310),
  sessionSecret: 'archon-lab-secret-2026',
  adminQueryKey: 'support-master-key',
}

'use strict'

const { launchOptions: productionLaunchOptions } = require('../../agents/browser-launch-options')

function launchOptions(chromium) {
  return productionLaunchOptions(chromium, ['--no-sandbox'])
}

module.exports = { launchOptions }

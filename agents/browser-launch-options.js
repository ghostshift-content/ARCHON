'use strict'

const fs = require('fs')

const SYSTEM_BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
]

function browserExecutable(chromium) {
  const candidates = [
    process.env.CHROMIUM_PATH,
    chromium && typeof chromium.executablePath === 'function' ? chromium.executablePath() : null,
    ...SYSTEM_BROWSERS,
  ].filter(Boolean)
  return candidates.find(file => fs.existsSync(file))
}

function launchOptions(chromium, args = []) {
  const executablePath = browserExecutable(chromium)
  return {
    ...(executablePath ? { executablePath } : {}),
    args,
  }
}

module.exports = { browserExecutable, launchOptions }

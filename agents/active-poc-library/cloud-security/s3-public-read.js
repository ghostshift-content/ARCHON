// agents/active-poc-library/cloud-security/s3-public-read.js
//
// Active-PoC probe: single GET on confirmed-public S3 URL to verify
// public-read capability. Aborts on 403 with AccessDenied body.

'use strict'

const S3_PATTERN = /\.s3[.-][a-z0-9-]+\.amazonaws\.com|s3\.amazonaws\.com|\.s3\.[a-z0-9-]+\.amazonaws\.com/i

module.exports = {
  name: 's3-public-read',
  squad: 'cloud-security',
  targets_capability: 's3-public-read',
  max_attempts: 1,
  description: 'Single GET on confirmed S3 URL to verify public read.',

  async run(finding, { fetchImpl } = {}) {
    const url = finding.url || finding.affected_url
    if (!url || !S3_PATTERN.test(url)) {
      return { skipped: true, skip_reason: 'url is not an S3 URL' }
    }
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'User-Agent': 'kurukshetra-cloud-poc/1.0' },
    })
    const body_preview = String(res.body || '').slice(0, 800)
    const isAccessDenied = res.status === 403 && /AccessDenied/i.test(body_preview)
    return {
      status: res.status,
      body_preview,
      public_readable: res.status === 200 && !isAccessDenied,
    }
  },
}

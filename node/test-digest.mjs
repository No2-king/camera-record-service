import { md5, parseChallenge, buildDigest } from './hik-client.mjs'
import { toUtcDate } from './hik-service.mjs'

let pass = true
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) pass = false
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      实际 ${actual}\n      期望 ${expected}`)
}

console.log('--- RFC 2617 Digest 标准测试向量 ---')
const ha1 = md5('Mufasa:testrealm@host.com:Circle Of Life')
const ha2 = md5('GET:/dir/index.html')
check('HA1', ha1, '939e7578ed9e3c518a452acee763bce9')
check('HA2', ha2, '39aff3a2bab6126f332b942af96d3366')
check('response', md5(`${ha1}:dcd98b7102dd2f0e8b11d0f600bfb0c093:00000001:0a4f113b:auth:${ha2}`),
  '6629fae49393a05397450978507c4ef1')

console.log('\n--- 解析海康风格 challenge ---')
const ch = 'Digest realm="IP Camera", qop="auth", nonce="abc123", stale=FALSE, algorithm=MD5'
const p = parseChallenge(ch)
check('realm', p.realm, 'IP Camera')
check('qop', p.qop, 'auth')
check('nonce', p.nonce, 'abc123')
check('algorithm', p.algorithm, 'MD5')

console.log('\n--- buildDigest 输出结构 ---')
const d = buildDigest('POST', '/ISAPI/ContentMgmt/search', ch, 'admin', 'pw')
for (const k of ['username="admin"', 'realm="IP Camera"', 'nonce="abc123"', 'qop=auth', 'algorithm=MD5', 'response="']) {
  check(`包含 ${k}`, d.includes(k), true)
}

console.log('\n--- 本地时间转 UTC（北京 UTC+8）---')
check('08:00 -> 00:00Z', toUtcDate('2026-10-15 08:00:00', 8).toISOString(), '2026-10-15T00:00:00.000Z')
check('00:30 跨天', toUtcDate('2026-10-15 00:30:00', 8).toISOString(), '2026-10-14T16:30:00.000Z')
check('T 分隔符也认', toUtcDate('2026-10-15T23:59:59', 8).toISOString(), '2026-10-15T15:59:59.000Z')

console.log(pass ? '\n=== 全部通过 ===' : '\n=== 有失败项 ===')
process.exit(pass ? 0 : 1)

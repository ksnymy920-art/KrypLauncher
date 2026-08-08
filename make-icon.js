const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZE = 256
const px = Buffer.alloc(SIZE * SIZE * 4)

function setPx(x, y, r, g, b, a) {
  const i = (y * SIZE + x) * 4
  px[i] = r
  px[i + 1] = g
  px[i + 2] = b
  px[i + 3] = a === undefined ? 255 : a
}

let seed = 987654321
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

const L = 30
const R = SIZE - 30
const T = 30
const B = SIZE - 30
const grassH = Math.round(SIZE * 0.3)

for (let y = T; y < B; y++) {
  for (let x = L; x < R; x++) {
    const n = rand()
    let r = 110
    let g = 75
    let b = 47
    if (n < 0.12) { r = 92; g = 60; b = 36 }
    else if (n < 0.18) { r = 140; g = 98; b = 62 }
    setPx(x, y, r, g, b)
  }
}

for (let y = T; y < T + grassH && y < B; y++) {
  for (let x = L; x < R; x++) {
    const n = rand()
    let r = 94
    let g = 143
    let b = 60
    if (n < 0.15) { r = 76; g = 120; b = 46 }
    else if (n < 0.25) { r = 116; g = 166; b = 76 }
    setPx(x, y, r, g, b)
  }
}

for (let x = L; x < R; x++) {
  const w = Math.round(4 + rand() * 8)
  const yy = T + grassH + w
  for (let j = 0; j < 6 && yy - j > T; j++) setPx(x, yy - j, 76, 52, 30)
}

for (let y = T; y < B; y++) {
  for (let x = L; x < R; x++) {
    if (x === L || x === R - 1 || y === T || y === B - 1) setPx(x, y, 20, 14, 8)
  }
}
for (let x = L + 1; x < R - 1; x++) {
  setPx(x, T, 44, 34, 20)
  setPx(x, T + 1, 36, 26, 15)
}
for (let y = T + 1; y < B - 1; y++) setPx(L, y, 34, 24, 14)

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

function encodePNG() {
  const stride = 1 + SIZE * 4
  const raw = Buffer.alloc(SIZE * stride)
  for (let y = 0; y < SIZE; y++) {
    raw[y * stride] = 0
    px.copy(raw, y * stride + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const png = encodePNG()
fs.writeFileSync(path.join(__dirname, 'icon.png'), png)

const ico = Buffer.alloc(22)
ico.writeUInt16LE(0, 0)
ico.writeUInt16LE(1, 2)
ico.writeUInt16LE(1, 4)
ico.writeUInt8(0, 6)
ico.writeUInt8(0, 7)
ico.writeUInt8(0, 8)
ico.writeUInt8(0, 9)
ico.writeUInt16LE(1, 10)
ico.writeUInt16LE(32, 12)
ico.writeUInt32LE(png.length, 14)
ico.writeUInt32LE(22, 18)
fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([ico, png]))

console.log('icons written:', path.join(__dirname, 'icon.png'), path.join(__dirname, 'icon.ico'))

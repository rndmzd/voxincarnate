export const MAX_SOUND_BYTES = 16 * 1024 * 1024;

/** Accept bounded, uncompressed WAV effects before copying them into managed storage. */
export function validateWav(bytes: Buffer): void {
  const fail = (message: string): never => { throw new Error(message); };
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > MAX_SOUND_BYTES) fail('Use a WAV sound between 44 bytes and 16 MB.');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) fail('Use a complete, uncompressed WAV file.');
  let format: { rate: number; align: number } | undefined;
  let dataSize = 0;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail('WAV file has an incomplete chunk.');
    const kind = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const begin = offset + 8;
    if (begin + size > bytes.length) fail('WAV file has an incomplete chunk.');
    if (kind === 'fmt ') {
      if (format || size < 16) fail('WAV format is invalid.');
      const encoding = bytes.readUInt16LE(begin), channels = bytes.readUInt16LE(begin + 2);
      const rate = bytes.readUInt32LE(begin + 4), byteRate = bytes.readUInt32LE(begin + 8);
      const align = bytes.readUInt16LE(begin + 12), bits = bytes.readUInt16LE(begin + 14);
      if (!((encoding === 1 && [8, 16, 24, 32].includes(bits)) || (encoding === 3 && [32, 64].includes(bits))) ||
          ![1, 2].includes(channels) || rate < 8000 || rate > 192000 || align !== channels * bits / 8 || byteRate !== rate * align) fail('Use a mono or stereo PCM / float WAV file (8–192 kHz).');
      format = { rate, align };
    } else if (kind === 'data') dataSize += size;
    offset = begin + size + (size % 2);
  }
  if (!format) return fail('WAV file has missing or incomplete audio.');
  if (offset !== bytes.length || !dataSize || dataSize % format.align) fail('WAV file has missing or incomplete audio.');
  if (dataSize / format.align / format.rate > 60) fail('Use a sound effect no longer than 60 seconds.');
}

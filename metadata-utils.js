/**
 * Halation Optical Studio — Binary Image Metadata Preservation & Stripping Engine
 *
 * Extracts, preserves, converts, and optionally strips binary metadata chunks
 * (EXIF, XMP, ICC Profile, IPTC, PNG eXIf/tEXt/iTXt/zTXt/pHYs/tIME/iCCP, WebP EXIF/XMP/ICCP)
 * across JPEG, PNG, and WebP formats with zero quality loss.
 */

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXIF_HEADER = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
const XMP_HEADER_STR = 'http://ns.adobe.com/xap/1.0/\0';
const ICC_HEADER_STR = 'ICC_PROFILE\0';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

// Precompute IEEE 802.3 CRC32 table for PNG chunk integrity
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(typeBytes, dataBytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < typeBytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ typeBytes[i]) & 0xff] ^ (crc >>> 8);
  }
  for (let i = 0; i < dataBytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ dataBytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function startsWithBytes(buf, prefix, offset = 0) {
  if (buf.length < offset + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buf[offset + i] !== prefix[i]) return false;
  }
  return true;
}

function asciiToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    out[i] = str.charCodeAt(i) & 0xff;
  }
  return out;
}

function bytesToAscii(buf, start = 0, end = buf.length) {
  let s = '';
  const limit = Math.min(buf.length, end);
  for (let i = start; i < limit; i++) {
    s += String.fromCharCode(buf[i]);
  }
  return s;
}

function readU16BE(buf, offset) {
  return ((buf[offset] << 8) | buf[offset + 1]) >>> 0;
}

function readU32BE(buf, offset) {
  return (
    ((buf[offset] << 24) |
      (buf[offset + 1] << 16) |
      (buf[offset + 2] << 8) |
      buf[offset + 3]) >>>
    0
  );
}

function readU32LE(buf, offset) {
  return (
    (buf[offset] |
      (buf[offset + 1] << 8) |
      (buf[offset + 2] << 16) |
      (buf[offset + 3] << 24)) >>>
    0
  );
}

function writeU32BE(buf, offset, val) {
  buf[offset] = (val >>> 24) & 0xff;
  buf[offset + 1] = (val >>> 16) & 0xff;
  buf[offset + 2] = (val >>> 8) & 0xff;
  buf[offset + 3] = val & 0xff;
}

function writeU32LE(buf, offset, val) {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
  buf[offset + 2] = (val >>> 16) & 0xff;
  buf[offset + 3] = (val >>> 24) & 0xff;
}

function concatUint8Arrays(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

/**
 * Detects MIME format from magic bytes.
 */
export function detectImageMime(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (startsWithBytes(u8, PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (
    u8.length >= 12 &&
    bytesToAscii(u8, 0, 4) === 'RIFF' &&
    bytesToAscii(u8, 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'unknown';
}

/**
 * Parses IFD0 of a raw EXIF TIFF buffer to extract embedded Title / ImageDescription / DocumentName.
 */
export function parseExifTitle(tiffBytes) {
  if (!tiffBytes || tiffBytes.length < 8) return null;
  const endian = bytesToAscii(tiffBytes, 0, 2);
  const le = endian === 'II';
  if (!le && endian !== 'MM') return null;

  const read16 = (off) =>
    le
      ? (tiffBytes[off] | (tiffBytes[off + 1] << 8)) >>> 0
      : ((tiffBytes[off] << 8) | tiffBytes[off + 1]) >>> 0;
  const read32 = (off) =>
    le ? readU32LE(tiffBytes, off) : readU32BE(tiffBytes, off);

  if (read16(2) !== 42) return null;
  const ifd0Offset = read32(4);
  if (ifd0Offset + 2 > tiffBytes.length) return null;

  const numEntries = read16(ifd0Offset);
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = ifd0Offset + 2 + i * 12;
    if (entryOffset + 12 > tiffBytes.length) break;
    const tag = read16(entryOffset);
    const type = read16(entryOffset + 2);
    const count = read32(entryOffset + 4);

    // 0x010D = DocumentName, 0x010E = ImageDescription
    if ((tag === 0x010d || tag === 0x010e) && type === 2 && count > 0) {
      const valOffset = count <= 4 ? entryOffset + 8 : read32(entryOffset + 8);
      if (valOffset + count <= tiffBytes.length) {
        const strBytes = tiffBytes.slice(valOffset, valOffset + count);
        const zeroIdx = strBytes.indexOf(0);
        const clean = zeroIdx >= 0 ? strBytes.slice(0, zeroIdx) : strBytes;
        const text = textDecoder.decode(clean).trim();
        if (text) return text;
      }
    }
    // 0x9C9B = XPTitle (UTF-16LE byte array)
    if (tag === 0x9c9b && (type === 1 || type === 7) && count > 2) {
      const valOffset = count <= 4 ? entryOffset + 8 : read32(entryOffset + 8);
      if (valOffset + count <= tiffBytes.length) {
        const utf16 = new TextDecoder('utf-16le').decode(
          tiffBytes.slice(valOffset, valOffset + count)
        );
        const clean = utf16.replace(/\0+$/, '').trim();
        if (clean) return clean;
      }
    }
  }
  return null;
}

/**
 * Parses an XMP UTF-8 string/bytes for <dc:title> value if present.
 */
function parseXmpTitle(xmpBytes) {
  if (!xmpBytes || xmpBytes.length === 0) return null;
  const xml = textDecoder.decode(xmpBytes);
  const dcTitleMatch = xml.match(/<dc:title[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i);
  if (dcTitleMatch && dcTitleMatch[1]) {
    return dcTitleMatch[1].trim();
  }
  return null;
}

/**
 * Creates a valid PNG chunk [4B length][4B type][data][4B CRC32].
 */
export function createPngChunk(typeStr, dataBytes) {
  const typeBytes = asciiToBytes(typeStr);
  const data = dataBytes instanceof Uint8Array ? dataBytes : new Uint8Array(dataBytes);
  const chunk = new Uint8Array(12 + data.length);
  writeU32BE(chunk, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crc = computeCrc32(typeBytes, data);
  writeU32BE(chunk, 8 + data.length, crc);
  return chunk;
}

/**
 * Creates a PNG tEXt chunk (keyword\0value).
 */
export function createPngTextChunk(keyword, value) {
  const keyBytes = asciiToBytes(keyword);
  const valBytes = textEncoder.encode(value);
  const data = new Uint8Array(keyBytes.length + 1 + valBytes.length);
  data.set(keyBytes, 0);
  data[keyBytes.length] = 0;
  data.set(valBytes, keyBytes.length + 1);
  return createPngChunk('tEXt', data);
}

/**
 * Creates a PNG iTXt chunk (keyword\0\0\0\0\0utf8_value).
 */
export function createPngITXtChunk(keyword, valueBytesOrString) {
  const keyBytes = asciiToBytes(keyword);
  const valBytes =
    typeof valueBytesOrString === 'string'
      ? textEncoder.encode(valueBytesOrString)
      : valueBytesOrString;
  const data = new Uint8Array(keyBytes.length + 5 + valBytes.length);
  data.set(keyBytes, 0);
  // null separator + compressionFlag(0) + compressionMethod(0) + langTag("")\0 + translatedKey("")\0
  data.set(valBytes, keyBytes.length + 5);
  return createPngChunk('iTXt', data);
}

/**
 * Creates a JPEG segment [0xFF, marker, lenHi, lenLo, ...payload].
 */
export function createJpegSegment(markerByte, payloadBytes) {
  const segLen = payloadBytes.length + 2;
  if (segLen > 0xffff) return null;
  const seg = new Uint8Array(2 + segLen);
  seg[0] = 0xff;
  seg[1] = markerByte & 0xff;
  seg[2] = (segLen >>> 8) & 0xff;
  seg[3] = segLen & 0xff;
  seg.set(payloadBytes, 4);
  return seg;
}

/**
 * Extracts all metadata chunks/segments from a JPEG, PNG, or WebP buffer.
 */
export function extractImageMetadata(buffer, mimeHint = '', fileName = '') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0);
  const format = detectImageMime(bytes) !== 'unknown' ? detectImageMime(bytes) : mimeHint;
  const cleanFileTitle = fileName ? fileName.replace(/\.[^/.]+$/, '') : '';

  const bundle = {
    format,
    fileName: fileName || '',
    title: '',
    hasMetadata: false,
    tagsSummary: [],
    jpegSegments: [],
    pngChunks: [],
    webpChunks: [],
    rawExifTiff: null,
    rawXmp: null,
    rawIcc: null,
  };

  const addTag = (tag) => {
    if (!bundle.tagsSummary.includes(tag)) bundle.tagsSummary.push(tag);
  };

  if (format === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const xmpPrefix = asciiToBytes(XMP_HEADER_STR);
    const iccPrefix = asciiToBytes(ICC_HEADER_STR);

    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) break;
      const marker = bytes[offset];
      offset++;

      // SOS (0xDA) or EOI (0xD9) ends metadata header region
      if (marker === 0xda || marker === 0xd9) break;
      // Standalone markers without length
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;

      if (offset + 2 > bytes.length) break;
      const segLen = readU16BE(bytes, offset);
      if (segLen < 2 || offset + segLen > bytes.length) break;

      const fullSegment = bytes.slice(offset - 2, offset + segLen);
      const payload = bytes.slice(offset + 2, offset + segLen);

      // Preserve APP1..APP15 (except APP14 color transform) and COM (0xFE)
      const isAppMetadata = marker >= 0xe1 && marker <= 0xef && marker !== 0xee;
      const isComment = marker === 0xfe;

      if (isAppMetadata || isComment) {
        bundle.jpegSegments.push(fullSegment);
        bundle.hasMetadata = true;

        if (marker === 0xe1) {
          if (startsWithBytes(payload, EXIF_HEADER)) {
            bundle.rawExifTiff = payload.slice(6);
            addTag('EXIF');
            const exifTitle = parseExifTitle(bundle.rawExifTiff);
            if (exifTitle && !bundle.title) {
              bundle.title = exifTitle;
              addTag('Title');
            }
          } else if (startsWithBytes(payload, xmpPrefix)) {
            bundle.rawXmp = payload.slice(xmpPrefix.length);
            addTag('XMP');
            const xmpTitle = parseXmpTitle(bundle.rawXmp);
            if (xmpTitle && !bundle.title) {
              bundle.title = xmpTitle;
              addTag('Title');
            }
          } else {
            addTag('APP1');
          }
        } else if (marker === 0xe2) {
          if (startsWithBytes(payload, iccPrefix) && payload.length > 14) {
            if (payload[12] === 1 && payload[13] === 1) {
              bundle.rawIcc = payload.slice(14);
            }
            addTag('ICC');
          } else {
            addTag('APP2');
          }
        } else if (marker === 0xed) {
          addTag('IPTC');
        } else if (marker === 0xfe) {
          addTag('Comment');
        } else {
          addTag(`APP${marker - 0xe0}`);
        }
      }

      offset += segLen;
    }
  } else if (format === 'image/png' && startsWithBytes(bytes, PNG_SIGNATURE)) {
    const PRESERVED_PNG_CHUNKS = new Set([
      'eXIf',
      'tEXt',
      'zTXt',
      'iTXt',
      'iCCP',
      'pHYs',
      'tIME',
    ]);

    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = readU32BE(bytes, offset);
      const type = bytesToAscii(bytes, offset + 4, offset + 8);
      const chunkEnd = offset + 12 + length;
      if (chunkEnd > bytes.length) break;

      const data = bytes.slice(offset + 8, offset + 8 + length);
      const rawChunk = bytes.slice(offset, chunkEnd);

      if (PRESERVED_PNG_CHUNKS.has(type)) {
        bundle.pngChunks.push({ type, data, rawChunk });
        bundle.hasMetadata = true;

        if (type === 'eXIf') {
          bundle.rawExifTiff = startsWithBytes(data, EXIF_HEADER) ? data.slice(6) : data;
          addTag('EXIF');
          const exifTitle = parseExifTitle(bundle.rawExifTiff);
          if (exifTitle && !bundle.title) {
            bundle.title = exifTitle;
            addTag('Title');
          }
        } else if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
          const nulIdx = data.indexOf(0);
          const keyword = nulIdx > 0 ? bytesToAscii(data, 0, nulIdx) : '';
          if (keyword === 'XML:com.adobe.xmp') {
            // In iTXt, 5 bytes follow the keyword before UTF-8 XML
            const xmlStart = type === 'iTXt' ? Math.min(data.length, nulIdx + 5) : nulIdx + 1;
            bundle.rawXmp = data.slice(xmlStart);
            addTag('XMP');
            const xmpTitle = parseXmpTitle(bundle.rawXmp);
            if (xmpTitle && !bundle.title) {
              bundle.title = xmpTitle;
              addTag('Title');
            }
          } else if (keyword.toLowerCase() === 'title') {
            const valStart = type === 'iTXt' ? Math.min(data.length, nulIdx + 5) : nulIdx + 1;
            const valStr = textDecoder.decode(data.slice(valStart)).replace(/\0+$/, '').trim();
            if (valStr && !bundle.title) {
              bundle.title = valStr;
            }
            addTag('Title');
          } else {
            addTag('Text');
          }
        } else if (type === 'iCCP') {
          addTag('ICC');
        } else if (type === 'pHYs') {
          addTag('pHYs');
        } else if (type === 'tIME') {
          addTag('tIME');
        }
      }

      if (type === 'IEND') break;
      offset = chunkEnd;
    }
  } else if (
    format === 'image/webp' &&
    bytes.length >= 12 &&
    bytesToAscii(bytes, 0, 4) === 'RIFF' &&
    bytesToAscii(bytes, 8, 12) === 'WEBP'
  ) {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const fourCC = bytesToAscii(bytes, offset, offset + 4);
      const chunkSize = readU32LE(bytes, offset + 4);
      const dataStart = offset + 8;
      const dataEnd = dataStart + chunkSize;
      if (dataEnd > bytes.length) break;

      const data = bytes.slice(dataStart, dataEnd);
      if (fourCC === 'EXIF' || fourCC === 'XMP ' || fourCC === 'ICCP') {
        bundle.webpChunks.push({ fourCC, data });
        bundle.hasMetadata = true;
        if (fourCC === 'EXIF') {
          bundle.rawExifTiff = startsWithBytes(data, EXIF_HEADER) ? data.slice(6) : data;
          addTag('EXIF');
          const exifTitle = parseExifTitle(bundle.rawExifTiff);
          if (exifTitle && !bundle.title) {
            bundle.title = exifTitle;
            addTag('Title');
          }
        } else if (fourCC === 'XMP ') {
          bundle.rawXmp = data;
          addTag('XMP');
          const xmpTitle = parseXmpTitle(bundle.rawXmp);
          if (xmpTitle && !bundle.title) {
            bundle.title = xmpTitle;
            addTag('Title');
          }
        } else if (fourCC === 'ICCP') {
          bundle.rawIcc = data;
          addTag('ICC');
        }
      }

      offset = dataEnd + (chunkSize & 1);
    }
  }

  if (!bundle.title && cleanFileTitle) {
    bundle.title = cleanFileTitle;
  }

  return bundle;
}

/**
 * Strips all non-essential metadata segments/chunks from an encoded JPEG, PNG, or WebP image.
 */
export function stripImageMetadataBytes(buffer, mimeHint = '') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0);
  const format = detectImageMime(bytes) !== 'unknown' ? detectImageMime(bytes) : mimeHint;

  if (format === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const keptParts = [bytes.slice(0, 2)]; // SOI
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) {
        keptParts.push(bytes.slice(offset));
        break;
      }
      const segStart = offset;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) break;
      const marker = bytes[offset];
      offset++;

      if (marker === 0xda || marker === 0xd9) {
        // From SOS or EOI to end of file is pure image bitstream
        keptParts.push(bytes.slice(segStart));
        break;
      }
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        keptParts.push(bytes.slice(segStart, offset));
        continue;
      }
      if (offset + 2 > bytes.length) {
        keptParts.push(bytes.slice(segStart));
        break;
      }
      const segLen = readU16BE(bytes, offset);
      if (segLen < 2 || offset + segLen > bytes.length) {
        keptParts.push(bytes.slice(segStart));
        break;
      }

      const isMetadataSeg =
        (marker >= 0xe1 && marker <= 0xef && marker !== 0xee) || marker === 0xfe;
      if (!isMetadataSeg) {
        keptParts.push(bytes.slice(segStart, offset + segLen));
      }
      offset += segLen;
    }
    return concatUint8Arrays(keptParts);
  }

  if (format === 'image/png' && startsWithBytes(bytes, PNG_SIGNATURE)) {
    const STRIP_PNG_TYPES = new Set([
      'eXIf',
      'tEXt',
      'zTXt',
      'iTXt',
      'iCCP',
      'pHYs',
      'tIME',
    ]);
    const keptParts = [bytes.slice(0, 8)];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = readU32BE(bytes, offset);
      const type = bytesToAscii(bytes, offset + 4, offset + 8);
      const chunkEnd = offset + 12 + length;
      if (chunkEnd > bytes.length) {
        keptParts.push(bytes.slice(offset));
        break;
      }
      if (!STRIP_PNG_TYPES.has(type)) {
        keptParts.push(bytes.slice(offset, chunkEnd));
      }
      offset = chunkEnd;
      if (type === 'IEND') break;
    }
    return concatUint8Arrays(keptParts);
  }

  if (
    format === 'image/webp' &&
    bytes.length >= 12 &&
    bytesToAscii(bytes, 0, 4) === 'RIFF' &&
    bytesToAscii(bytes, 8, 12) === 'WEBP'
  ) {
    const STRIP_WEBP = new Set(['EXIF', 'XMP ', 'ICCP']);
    const chunks = [];
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const fourCC = bytesToAscii(bytes, offset, offset + 4);
      const chunkSize = readU32LE(bytes, offset + 4);
      const paddedSize = chunkSize + (chunkSize & 1);
      const chunkEnd = offset + 8 + paddedSize;
      if (offset + 8 + chunkSize > bytes.length) break;

      if (!STRIP_WEBP.has(fourCC)) {
        const raw = bytes.slice(offset, Math.min(bytes.length, chunkEnd));
        if (fourCC === 'VP8X' && raw.length >= 18) {
          // Clear ICCP (0x20), EXIF (0x08), XMP (0x04) flags
          raw[8] &= ~(0x20 | 0x08 | 0x04);
        }
        chunks.push(raw);
      }
      offset = chunkEnd;
    }
    const body = concatUint8Arrays(chunks);
    const out = new Uint8Array(12 + body.length);
    out.set(asciiToBytes('RIFF'), 0);
    writeU32LE(out, 4, 4 + body.length);
    out.set(asciiToBytes('WEBP'), 8);
    out.set(body, 12);
    return out;
  }

  return bytes;
}

/**
 * Injects preserved metadata into an encoded JPEG, PNG, or WebP byte array.
 */
export function injectImageMetadataBytes(buffer, metadataBundle, targetMime = '') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0);
  if (!metadataBundle) return bytes;

  const format =
    detectImageMime(bytes) !== 'unknown' ? detectImageMime(bytes) : targetMime;

  if (format === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let segmentsToInject = [];

    if (metadataBundle.jpegSegments && metadataBundle.jpegSegments.length > 0) {
      segmentsToInject = metadataBundle.jpegSegments;
    } else {
      if (metadataBundle.rawExifTiff && metadataBundle.rawExifTiff.length > 0) {
        const payload = concatUint8Arrays([EXIF_HEADER, metadataBundle.rawExifTiff]);
        const seg = createJpegSegment(0xe1, payload);
        if (seg) segmentsToInject.push(seg);
      }
      if (metadataBundle.rawXmp && metadataBundle.rawXmp.length > 0) {
        const payload = concatUint8Arrays([
          asciiToBytes(XMP_HEADER_STR),
          metadataBundle.rawXmp,
        ]);
        const seg = createJpegSegment(0xe1, payload);
        if (seg) segmentsToInject.push(seg);
      }
      if (metadataBundle.rawIcc && metadataBundle.rawIcc.length > 0) {
        const iccHdr = new Uint8Array(14);
        iccHdr.set(asciiToBytes(ICC_HEADER_STR), 0);
        iccHdr[12] = 1;
        iccHdr[13] = 1;
        const payload = concatUint8Arrays([iccHdr, metadataBundle.rawIcc]);
        const seg = createJpegSegment(0xe2, payload);
        if (seg) segmentsToInject.push(seg);
      }
    }

    if (segmentsToInject.length === 0) return bytes;

    // Strip any default metadata segments from the canvas JPEG first
    const cleanJpeg = stripImageMetadataBytes(bytes, 'image/jpeg');

    // Insert right after SOI (or after APP0 JFIF if present at offset 2)
    let insertPos = 2;
    if (
      cleanJpeg.length >= 6 &&
      cleanJpeg[2] === 0xff &&
      cleanJpeg[3] === 0xe0
    ) {
      const app0Len = readU16BE(cleanJpeg, 4);
      if (2 + 2 + app0Len <= cleanJpeg.length) {
        insertPos = 2 + 2 + app0Len;
      }
    }

    return concatUint8Arrays([
      cleanJpeg.slice(0, insertPos),
      ...segmentsToInject,
      cleanJpeg.slice(insertPos),
    ]);
  }

  if (format === 'image/png' && startsWithBytes(bytes, PNG_SIGNATURE)) {
    let chunksToInsert = [];

    if (metadataBundle.pngChunks && metadataBundle.pngChunks.length > 0) {
      chunksToInsert = metadataBundle.pngChunks.map((c) => c.rawChunk);
    } else {
      if (metadataBundle.rawExifTiff && metadataBundle.rawExifTiff.length > 0) {
        chunksToInsert.push(createPngChunk('eXIf', metadataBundle.rawExifTiff));
      }
      if (metadataBundle.rawXmp && metadataBundle.rawXmp.length > 0) {
        chunksToInsert.push(createPngITXtChunk('XML:com.adobe.xmp', metadataBundle.rawXmp));
      }
      if (metadataBundle.title) {
        chunksToInsert.push(createPngTextChunk('Title', metadataBundle.title));
      }
    }

    if (chunksToInsert.length === 0) return bytes;

    // Strip any duplicate metadata chunks from canvas PNG before splicing preserved ones before first IDAT
    const cleanPng = stripImageMetadataBytes(bytes, 'image/png');
    const outParts = [cleanPng.slice(0, 8)];
    let injected = false;
    let offset = 8;

    while (offset + 12 <= cleanPng.length) {
      const length = readU32BE(cleanPng, offset);
      const type = bytesToAscii(cleanPng, offset + 4, offset + 8);
      const chunkEnd = offset + 12 + length;
      if (chunkEnd > cleanPng.length) {
        outParts.push(cleanPng.slice(offset));
        break;
      }
      if (!injected && (type === 'IDAT' || type === 'IEND')) {
        outParts.push(...chunksToInsert);
        injected = true;
      }
      outParts.push(cleanPng.slice(offset, chunkEnd));
      offset = chunkEnd;
      if (type === 'IEND') break;
    }

    return concatUint8Arrays(outParts);
  }

  if (
    format === 'image/webp' &&
    bytes.length >= 12 &&
    bytesToAscii(bytes, 0, 4) === 'RIFF' &&
    bytesToAscii(bytes, 8, 12) === 'WEBP'
  ) {
    const metaChunks = [];
    let flagsMask = 0;

    if (metadataBundle.webpChunks && metadataBundle.webpChunks.length > 0) {
      for (const c of metadataBundle.webpChunks) {
        metaChunks.push(c);
        if (c.fourCC === 'ICCP') flagsMask |= 0x20;
        if (c.fourCC === 'EXIF') flagsMask |= 0x08;
        if (c.fourCC === 'XMP ') flagsMask |= 0x04;
      }
    } else {
      if (metadataBundle.rawIcc && metadataBundle.rawIcc.length > 0) {
        metaChunks.push({ fourCC: 'ICCP', data: metadataBundle.rawIcc });
        flagsMask |= 0x20;
      }
      if (metadataBundle.rawExifTiff && metadataBundle.rawExifTiff.length > 0) {
        metaChunks.push({ fourCC: 'EXIF', data: metadataBundle.rawExifTiff });
        flagsMask |= 0x08;
      }
      if (metadataBundle.rawXmp && metadataBundle.rawXmp.length > 0) {
        metaChunks.push({ fourCC: 'XMP ', data: metadataBundle.rawXmp });
        flagsMask |= 0x04;
      }
    }

    if (metaChunks.length === 0) return bytes;

    const cleanWebp = stripImageMetadataBytes(bytes, 'image/webp');
    const serializedMeta = metaChunks.map(({ fourCC, data }) => {
      const pad = data.length & 1;
      const chunk = new Uint8Array(8 + data.length + pad);
      chunk.set(asciiToBytes(fourCC), 0);
      writeU32LE(chunk, 4, data.length);
      chunk.set(data, 8);
      return chunk;
    });

    // If cleanWebp already starts with VP8X, set flagsMask on it and append metaChunks
    if (cleanWebp.length >= 30 && bytesToAscii(cleanWebp, 12, 16) === 'VP8X') {
      const updated = cleanWebp.slice();
      updated[20] |= flagsMask;
      const combinedBody = concatUint8Arrays([updated.slice(12), ...serializedMeta]);
      const out = new Uint8Array(12 + combinedBody.length);
      out.set(asciiToBytes('RIFF'), 0);
      writeU32LE(out, 4, 4 + combinedBody.length);
      out.set(asciiToBytes('WEBP'), 8);
      out.set(combinedBody, 12);
      return out;
    }

    // Otherwise append metadata chunks to the RIFF WEBP container and update RIFF size
    const combinedBody = concatUint8Arrays([cleanWebp.slice(12), ...serializedMeta]);
    const out = new Uint8Array(12 + combinedBody.length);
    out.set(asciiToBytes('RIFF'), 0);
    writeU32LE(out, 4, 4 + combinedBody.length);
    out.set(asciiToBytes('WEBP'), 8);
    out.set(combinedBody, 12);
    return out;
  }

  return bytes;
}

/**
 * High-level Blob helper: either injects preserved metadata or strips metadata from an exported Blob.
 */
export async function processExportBlobMetadata(blob, metadataBundle, stripMetadata = false) {
  const arrayBuffer = await blob.arrayBuffer();
  const inputBytes = new Uint8Array(arrayBuffer);
  const outBytes = stripMetadata
    ? stripImageMetadataBytes(inputBytes, blob.type)
    : injectImageMetadataBytes(inputBytes, metadataBundle, blob.type);
  return new Blob([outBytes], { type: blob.type });
}

/**
 * Computes the exact export filename preserving the uploaded file's exact title/filename.
 * - If the target export format matches the uploaded file's format, returns the exact uploaded filename
 *   (including original extension case, e.g. "DSC_0142.JPG" or "Night Study.png").
 * - If the user manually selects a different export format, preserves the exact filename stem with the selected extension.
 */
export function getExactExportFilename(originalFileName, originalMime, targetMime, targetExt) {
  const fallback = `photo.${targetExt || 'png'}`;
  if (!originalFileName || typeof originalFileName !== 'string') return fallback;

  const trimmed = originalFileName.trim();
  if (!trimmed) return fallback;

  const extMatch = trimmed.match(/^(.*)\.([^.]+)$/);
  if (!extMatch) {
    return `${trimmed}.${targetExt || 'png'}`;
  }

  const stem = extMatch[1] || trimmed;
  const origExt = extMatch[2];
  const origExtLower = origExt.toLowerCase();

  const mimeMatchesExt =
    (targetMime === 'image/jpeg' && (origExtLower === 'jpg' || origExtLower === 'jpeg')) ||
    (targetMime === 'image/png' && origExtLower === 'png') ||
    (targetMime === 'image/webp' && origExtLower === 'webp') ||
    (originalMime && targetMime === originalMime);

  if (mimeMatchesExt) {
    return trimmed;
  }

  return `${stem}.${targetExt || origExtLower}`;
}

/**
 * Builds a minimal valid EXIF TIFF payload with ImageDescription (Title), Make, Model, Software, and Artist
 * for automated tests and verification.
 */
export function buildExifTiffPayload({
  title = 'Midnight Neon Kiosk',
  artist = 'Halation Studio Photographer',
  make = 'Leica Camera AG',
  model = 'Leica M6 TTL 35mm',
} = {}) {
  // Little-endian TIFF ('II', 42, IFD0 at offset 8)
  const entries = [
    { tag: 0x010e, str: title },  // ImageDescription (Title)
    { tag: 0x010f, str: make },   // Make
    { tag: 0x0110, str: model },  // Model
    { tag: 0x013b, str: artist }, // Artist
  ];

  const ifdSize = 2 + entries.length * 12 + 4;
  let dataOffset = 8 + ifdSize;
  const encodedStrings = entries.map((e) => {
    const bytes = textEncoder.encode(e.str + '\0');
    const pad = bytes.length & 1 ? 1 : 0;
    const buf = new Uint8Array(bytes.length + pad);
    buf.set(bytes, 0);
    const item = { tag: e.tag, count: bytes.length, offset: dataOffset, buf };
    dataOffset += buf.length;
    return item;
  });

  const out = new Uint8Array(dataOffset);
  // 'II' + 42 + offset 8
  out[0] = 0x49;
  out[1] = 0x49;
  out[2] = 0x2a;
  out[3] = 0x00;
  writeU32LE(out, 4, 8);

  // Number of entries
  out[8] = entries.length & 0xff;
  out[9] = (entries.length >>> 8) & 0xff;

  encodedStrings.forEach((item, idx) => {
    const pos = 10 + idx * 12;
    out[pos] = item.tag & 0xff;
    out[pos + 1] = (item.tag >>> 8) & 0xff;
    out[pos + 2] = 2; // ASCII
    out[pos + 3] = 0;
    writeU32LE(out, pos + 4, item.count);
    if (item.count <= 4) {
      out.set(item.buf.slice(0, item.count), pos + 8);
    } else {
      writeU32LE(out, pos + 8, item.offset);
      out.set(item.buf, item.offset);
    }
  });

  return out;
}

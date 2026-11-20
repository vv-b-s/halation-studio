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

function isExifApp1Payload(payload) {
  return (
    Boolean(payload) &&
    payload.length > 6 &&
    payload[0] === 0x45 &&
    payload[1] === 0x78 &&
    payload[2] === 0x69 &&
    payload[3] === 0x66 &&
    payload[4] === 0x00
  );
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
 * Parses IFD0 (and ExifSubIFD fallback) and the GPSInfo Sub-IFD (tag 0x8825) of a raw EXIF TIFF buffer
 * to detect and decode GPS coordinates (latitude, longitude, altitude).
 * Rejects uninitialized or OS-redacted 0/0 rational templates.
 */
export function parseExifGps(tiffBytes, { ifd0Only = false } = {}) {
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
  const readPtr = (entryOffset) => {
    const type = read16(entryOffset + 2);
    return type === 3 ? read16(entryOffset + 8) : read32(entryOffset + 8);
  };

  if (read16(2) !== 42) return null;
  const ifd0Offset = read32(4);
  if (ifd0Offset + 2 > tiffBytes.length) return null;

  const numEntries = read16(ifd0Offset);
  if (numEntries > 256 || ifd0Offset + 2 + numEntries * 12 > tiffBytes.length) return null;

  const candidateGpsOffsets = [];
  let exifSubIfdOffset = 0;

  for (let i = 0; i < numEntries; i++) {
    const entryOffset = ifd0Offset + 2 + i * 12;
    const tag = read16(entryOffset);
    if (tag === 0x8825) {
      candidateGpsOffsets.push(readPtr(entryOffset));
    } else if (tag === 0x8769) {
      exifSubIfdOffset = readPtr(entryOffset);
    }
  }

  if (!ifd0Only && exifSubIfdOffset > 0 && exifSubIfdOffset + 2 <= tiffBytes.length) {
    const subEntries = read16(exifSubIfdOffset);
    if (subEntries > 0 && subEntries <= 256 && exifSubIfdOffset + 2 + subEntries * 12 <= tiffBytes.length) {
      for (let i = 0; i < subEntries; i++) {
        const entryOffset = exifSubIfdOffset + 2 + i * 12;
        if (read16(entryOffset) === 0x8825) {
          candidateGpsOffsets.push(readPtr(entryOffset));
        }
      }
    }
  }

  const readRational = (off, isSigned = false) => {
    if (off + 8 > tiffBytes.length) return null;
    const rawNum = read32(off);
    const rawDen = read32(off + 4);
    const num = isSigned ? rawNum | 0 : rawNum;
    const den = isSigned ? rawDen | 0 : rawDen;
    if (den === 0) return null;
    return num / den;
  };

  const isZeroZeroRational = (off) => {
    if (off + 8 > tiffBytes.length) return false;
    return read32(off) === 0 && read32(off + 4) === 0;
  };

  const readCoordRationals = (off, count, isSigned) => {
    if (count < 1 || off + count * 8 > tiffBytes.length) return null;
    const d = readRational(off, isSigned);
    if (d === null) return null;
    let m = 0;
    if (count >= 2) {
      const mVal = readRational(off + 8, isSigned);
      if (mVal === null) {
        if (!isZeroZeroRational(off + 8)) return null;
        m = 0;
      } else {
        m = mVal;
      }
    }
    let s = 0;
    if (count >= 3) {
      const sVal = readRational(off + 16, isSigned);
      if (sVal === null) {
        if (!isZeroZeroRational(off + 16)) return null;
        s = 0;
      } else {
        s = sVal;
      }
    }
    const sign = d < 0 ? -1 : 1;
    return sign * (Math.abs(d) + Math.abs(m) / 60 + Math.abs(s) / 3600);
  };

  const decodeGpsIfd = (gpsIfdOffset) => {
    if (!gpsIfdOffset || gpsIfdOffset + 2 > tiffBytes.length) return null;
    const numGpsEntries = read16(gpsIfdOffset);
    if (
      numGpsEntries === 0 ||
      numGpsEntries > 64 ||
      gpsIfdOffset + 2 + numGpsEntries * 12 > tiffBytes.length
    ) {
      return null;
    }

    let latRef = '';
    let lonRef = '';
    let altRef = 0;
    let latVal = null;
    let lonVal = null;
    let altVal = null;

    for (let i = 0; i < numGpsEntries; i++) {
      const entryOffset = gpsIfdOffset + 2 + i * 12;
      const tag = read16(entryOffset);
      const type = read16(entryOffset + 2);
      const count = read32(entryOffset + 4);
      const valOffset = readPtr(entryOffset);

      if (tag === 0x0001 && (type === 1 || type === 2 || type === 7) && count >= 1) {
        const charOff = count <= 4 ? entryOffset + 8 : valOffset;
        if (charOff < tiffBytes.length) {
          const ch = String.fromCharCode(tiffBytes[charOff]).toUpperCase();
          if (ch === 'N' || ch === 'S') latRef = ch;
        }
      } else if (tag === 0x0002 && (type === 5 || type === 10) && count >= 1 && count <= 3) {
        const coordOff = count * 8 <= 4 ? entryOffset + 8 : valOffset;
        latVal = readCoordRationals(coordOff, count, type === 10);
      } else if (tag === 0x0003 && (type === 1 || type === 2 || type === 7) && count >= 1) {
        const charOff = count <= 4 ? entryOffset + 8 : valOffset;
        if (charOff < tiffBytes.length) {
          const ch = String.fromCharCode(tiffBytes[charOff]).toUpperCase();
          if (ch === 'E' || ch === 'W') lonRef = ch;
        }
      } else if (tag === 0x0004 && (type === 5 || type === 10) && count >= 1 && count <= 3) {
        const coordOff = count * 8 <= 4 ? entryOffset + 8 : valOffset;
        lonVal = readCoordRationals(coordOff, count, type === 10);
      } else if (tag === 0x0005 && (type === 1 || type === 2 || type === 3) && count >= 1) {
        altRef = tiffBytes[entryOffset + 8] === 1 ? 1 : 0;
      } else if (tag === 0x0006 && (type === 5 || type === 10) && count === 1) {
        altVal = readRational(valOffset, type === 10);
      }
    }

    if (latVal === null || lonVal === null) return null;
    // Reject uninitialized 0,0 templates when N/S/E/W reference chars are missing
    if (latVal === 0 && lonVal === 0 && (!latRef || !lonRef)) return null;

    const signedLat = latRef === 'S' ? -Math.abs(latVal) : latRef === 'N' ? Math.abs(latVal) : latVal;
    const signedLon = lonRef === 'W' ? -Math.abs(lonVal) : lonRef === 'E' ? Math.abs(lonVal) : lonVal;
    if (
      Number.isNaN(signedLat) ||
      Number.isNaN(signedLon) ||
      Math.abs(signedLat) > 90 ||
      Math.abs(signedLon) > 180
    ) {
      return null;
    }

    return {
      latitude: Number(signedLat.toFixed(6)),
      longitude: Number(signedLon.toFixed(6)),
      latitudeRef: latRef || (signedLat < 0 ? 'S' : 'N'),
      longitudeRef: lonRef || (signedLon < 0 ? 'W' : 'E'),
      altitude:
        altVal !== null && !Number.isNaN(altVal)
          ? Number((altRef === 1 ? -Math.abs(altVal) : altVal).toFixed(2))
          : null,
    };
  };

  for (const off of candidateGpsOffsets) {
    const parsed = decodeGpsIfd(off);
    if (parsed) return parsed;
  }

  return null;
}

/**
 * Detects whether a raw EXIF TIFF buffer contains a GPSInfo (0x8825) Sub-IFD pointer
 * whose coordinate tags (0x0002 / 0x0004) or entry table were zeroed out / redacted
 * by an OS photo picker or MediaProvider (such as Android's ExifRedactor).
 */
export function hasRedactedExifGpsIfd(tiffBytes) {
  if (!tiffBytes || tiffBytes.length < 8) return false;
  if (parseExifGps(tiffBytes)) return false;

  const endian = bytesToAscii(tiffBytes, 0, 2);
  const le = endian === 'II';
  if (!le && endian !== 'MM') return false;

  const read16 = (off) =>
    le
      ? (tiffBytes[off] | (tiffBytes[off + 1] << 8)) >>> 0
      : ((tiffBytes[off] << 8) | tiffBytes[off + 1]) >>> 0;
  const read32 = (off) =>
    le ? readU32LE(tiffBytes, off) : readU32BE(tiffBytes, off);
  const readPtr = (entryOffset) => {
    const type = read16(entryOffset + 2);
    return type === 3 ? read16(entryOffset + 8) : read32(entryOffset + 8);
  };

  if (read16(2) !== 42) return false;
  const ifd0Offset = read32(4);
  if (ifd0Offset + 2 > tiffBytes.length) return false;
  const numEntries = read16(ifd0Offset);
  if (numEntries > 256 || ifd0Offset + 2 + numEntries * 12 > tiffBytes.length) return false;

  for (let i = 0; i < numEntries; i++) {
    const entryOffset = ifd0Offset + 2 + i * 12;
    if (read16(entryOffset) === 0x8825) {
      const gpsOff = readPtr(entryOffset);
      if (gpsOff > 0 && gpsOff + 2 <= tiffBytes.length) {
        const numGps = read16(gpsOff);
        // Either the entire GPS IFD was overwritten with zeros (numGps === 0)
        // or the coordinate entries inside it were zeroed out (parseExifGps returned null)
        if (numGps >= 0 && numGps <= 64) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Parses an XMP GPS coordinate string (e.g. "37,49.194N", "37,49,11.64N", "-122.4783", "122,28.698W")
 * into a signed decimal degree number.
 */
function parseXmpCoordinate(rawStr) {
  if (!rawStr || typeof rawStr !== 'string') return null;
  const s = rawStr.trim();
  if (!s) return null;

  const dirMatch = s.match(/([NSEW])$/i);
  const dir = dirMatch ? dirMatch[1].toUpperCase() : '';
  const body = dirMatch ? s.slice(0, -1).trim() : s;
  const parts = body.split(',').map((p) => Number(p.trim()));
  if (parts.some((n) => Number.isNaN(n))) return null;

  let val = 0;
  if (parts.length === 1) {
    val = parts[0];
  } else if (parts.length === 2) {
    const sign = parts[0] < 0 ? -1 : 1;
    val = sign * (Math.abs(parts[0]) + Math.abs(parts[1]) / 60);
  } else if (parts.length >= 3) {
    const sign = parts[0] < 0 ? -1 : 1;
    val = sign * (Math.abs(parts[0]) + Math.abs(parts[1]) / 60 + Math.abs(parts[2]) / 3600);
  }

  if (dir === 'S' || dir === 'W') val = -Math.abs(val);
  else if (dir === 'N' || dir === 'E') val = Math.abs(val);

  return Number.isNaN(val) ? null : Number(val.toFixed(6));
}

/**
 * Parses XMP bytes for exif:GPSLatitude, exif:GPSLongitude, and exif:GPSAltitude tags.
 */
export function parseXmpGps(xmpBytes) {
  if (!xmpBytes || xmpBytes.length === 0) return null;
  const xml = textDecoder.decode(xmpBytes);
  const latMatch =
    xml.match(/exif:GPSLatitude\s*=\s*["']([^"']+)["']/i) ||
    xml.match(/<exif:GPSLatitude>\s*([^<]+)\s*<\/exif:GPSLatitude>/i);
  const lonMatch =
    xml.match(/exif:GPSLongitude\s*=\s*["']([^"']+)["']/i) ||
    xml.match(/<exif:GPSLongitude>\s*([^<]+)\s*<\/exif:GPSLongitude>/i);
  if (!latMatch || !lonMatch) return null;

  const rawLatitude = latMatch[1].trim();
  const rawLongitude = lonMatch[1].trim();
  const latitude = parseXmpCoordinate(rawLatitude);
  const longitude = parseXmpCoordinate(rawLongitude);
  if (
    latitude === null ||
    longitude === null ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }

  let altitude = null;
  const altMatch =
    xml.match(/exif:GPSAltitude\s*=\s*["']([^"']+)["']/i) ||
    xml.match(/<exif:GPSAltitude>\s*([^<]+)\s*<\/exif:GPSAltitude>/i);
  const altRefMatch =
    xml.match(/exif:GPSAltitudeRef\s*=\s*["']([^"']+)["']/i) ||
    xml.match(/<exif:GPSAltitudeRef>\s*([^<]+)\s*<\/exif:GPSAltitudeRef>/i);
  if (altMatch) {
    const rawAlt = altMatch[1].trim();
    const slashIdx = rawAlt.indexOf('/');
    let parsedAlt = null;
    if (slashIdx > 0) {
      const num = Number(rawAlt.slice(0, slashIdx));
      const den = Number(rawAlt.slice(slashIdx + 1));
      if (!Number.isNaN(num) && !Number.isNaN(den) && den !== 0) parsedAlt = num / den;
    } else {
      const n = Number(rawAlt);
      if (!Number.isNaN(n)) parsedAlt = n;
    }
    if (parsedAlt !== null) {
      const belowSea = altRefMatch && altRefMatch[1].trim() === '1';
      altitude = Number((belowSea ? -Math.abs(parsedAlt) : parsedAlt).toFixed(2));
    }
  }

  return {
    latitude,
    longitude,
    latitudeRef: latitude < 0 ? 'S' : 'N',
    longitudeRef: longitude < 0 ? 'W' : 'E',
    altitude,
    rawLatitude,
    rawLongitude,
  };
}

/**
 * Checks whether a filename is a synthetic OS photo picker identifier
 * (e.g. Android 13+ Photo Picker MediaStore numeric IDs like "1000038492.jpg"
 * or iOS temporary UUIDs like "7F8A9B12-3C4D-5E6F-7A8B-9C0D1E2F3A4B.jpeg").
 */
export function isSyntheticPickerFilename(fileName) {
  if (!fileName || typeof fileName !== 'string') return false;
  const base = fileName.trim().split(/[/\\]/).pop()?.trim() || '';
  const stem = base.replace(/\.[^.]+$/, '');
  if (!stem) return true;
  // Android MediaStore / Photo Picker IDs: 4+ pure digits (e.g. "1000038492", "38492") or "image:1000038492"
  if (/^\d{4,}$/.test(stem)) return true;
  if (/^(?:image|media|picker|msf)[_:%-]?\d{4,}$/i.test(stem)) return true;
  // iOS PHPickerViewController / Blob temporary UUIDs
  if (/^(?:trim\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem)) {
    return true;
  }
  return false;
}

/**
 * Extracts embedded original filename or camera capture timestamp from EXIF/XMP metadata
 * to recover the real filename when a mobile OS photo picker substitutes a random numeric ID.
 */
export function resolveOriginalFileName(rawFileName, tiffBytes = null, xmpBytes = null) {
  const base = (rawFileName && rawFileName.trim().split(/[/\\]/).pop()?.trim()) || '';
  if (!isSyntheticPickerFilename(base)) {
    return base || 'photo.png';
  }

  const extMatch = base.match(/\.([^.]+)$/);
  const ext = extMatch ? extMatch[1] : 'jpg';

  // 1. Check XMP for xmpMM:PreservedFileName, crs:RawFileName, or photoshop:Source
  if (xmpBytes && xmpBytes.length > 0) {
    const xml = textDecoder.decode(xmpBytes);
    const preservedMatch =
      xml.match(/(?:xmpMM:PreservedFileName|crs:RawFileName)\s*=\s*["']([^"']+)["']/i) ||
      xml.match(/<(?:xmpMM:PreservedFileName|crs:RawFileName)>\s*([^<]+)\s*<\/(?:xmpMM:PreservedFileName|crs:RawFileName)>/i);
    if (preservedMatch && preservedMatch[1]) {
      const candidate = preservedMatch[1].trim().split(/[/\\]/).pop()?.trim();
      if (candidate && !isSyntheticPickerFilename(candidate)) {
        return candidate.includes('.') ? candidate : `${candidate}.${ext}`;
      }
    }
  }

  // 2. Check EXIF IFD0 for DocumentName (0x010D) or ExifSubIFD for DateTimeOriginal (0x9003) + Make (0x010F)
  if (tiffBytes && tiffBytes.length >= 8) {
    const endian = bytesToAscii(tiffBytes, 0, 2);
    const le = endian === 'II';
    if (le || endian === 'MM') {
      const read16 = (off) =>
        le
          ? (tiffBytes[off] | (tiffBytes[off + 1] << 8)) >>> 0
          : ((tiffBytes[off] << 8) | tiffBytes[off + 1]) >>> 0;
      const read32 = (off) => (le ? readU32LE(tiffBytes, off) : readU32BE(tiffBytes, off));
      const readAscii = (entryOffset) => {
        const type = read16(entryOffset + 2);
        const count = read32(entryOffset + 4);
        if (type !== 2 || count === 0) return '';
        const valOff = count <= 4 ? entryOffset + 8 : read32(entryOffset + 8);
        if (valOff + count > tiffBytes.length) return '';
        const slice = tiffBytes.slice(valOff, valOff + count);
        const nul = slice.indexOf(0);
        return textDecoder.decode(nul >= 0 ? slice.slice(0, nul) : slice).trim();
      };

      if (read16(2) === 42) {
        const ifd0Offset = read32(4);
        if (ifd0Offset + 2 <= tiffBytes.length) {
          const numEntries0 = read16(ifd0Offset);
          let docName = '';
          let make = '';
          let dateTime0 = '';
          let exifSubIfdOffset = 0;

          for (let i = 0; i < numEntries0; i++) {
            const entryOffset = ifd0Offset + 2 + i * 12;
            if (entryOffset + 12 > tiffBytes.length) break;
            const tag = read16(entryOffset);
            if (tag === 0x010d) docName = readAscii(entryOffset);
            else if (tag === 0x010f) make = readAscii(entryOffset);
            else if (tag === 0x0132) dateTime0 = readAscii(entryOffset);
            else if (tag === 0x8769) exifSubIfdOffset = read32(entryOffset + 8);
          }

          if (docName && !isSyntheticPickerFilename(docName)) {
            return docName.includes('.') ? docName : `${docName}.${ext}`;
          }

          let dateTimeOrig = '';
          let subSecOrig = '';
          if (exifSubIfdOffset > 0 && exifSubIfdOffset + 2 <= tiffBytes.length) {
            const subEntries = read16(exifSubIfdOffset);
            if (subEntries <= 256 && exifSubIfdOffset + 2 + subEntries * 12 <= tiffBytes.length) {
              for (let i = 0; i < subEntries; i++) {
                const entryOffset = exifSubIfdOffset + 2 + i * 12;
                const tag = read16(entryOffset);
                if (tag === 0x9003) dateTimeOrig = readAscii(entryOffset);
                else if (tag === 0x9004 && !dateTimeOrig) dateTimeOrig = readAscii(entryOffset);
                else if (tag === 0x9291) subSecOrig = readAscii(entryOffset);
              }
            }
          }

          const dt = dateTimeOrig || dateTime0;
          const dtMatch = dt.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
          if (dtMatch) {
            const ymd = `${dtMatch[1]}${dtMatch[2]}${dtMatch[3]}`;
            const hms = `${dtMatch[4]}${dtMatch[5]}${dtMatch[6]}`;
            const makeLower = make.toLowerCase();
            if (makeLower.includes('google')) {
              const ms = subSecOrig ? subSecOrig.slice(0, 3) : '';
              return `PXL_${ymd}_${hms}${ms}.${ext}`;
            }
            if (makeLower.includes('samsung')) {
              return `${ymd}_${hms}.${ext}`;
            }
            return `IMG_${ymd}_${hms}.${ext}`;
          }
        }
      }
    }
  }

  return base || 'photo.png';
}

/**
 * Parses IFD0 of a raw EXIF TIFF buffer to extract the EXIF Orientation tag (0x0112).
 * Returns 1..8 (defaults to 1 = Horizontal / Normal).
 */
export function parseExifOrientation(tiffBytes) {
  if (!tiffBytes || tiffBytes.length < 8) return 1;
  const endian = bytesToAscii(tiffBytes, 0, 2);
  const le = endian === 'II';
  if (!le && endian !== 'MM') return 1;

  const read16 = (off) =>
    le
      ? (tiffBytes[off] | (tiffBytes[off + 1] << 8)) >>> 0
      : ((tiffBytes[off] << 8) | tiffBytes[off + 1]) >>> 0;
  const read32 = (off) =>
    le ? readU32LE(tiffBytes, off) : readU32BE(tiffBytes, off);

  if (read16(2) !== 42) return 1;
  const ifd0Offset = read32(4);
  if (ifd0Offset + 2 > tiffBytes.length) return 1;

  const numEntries = read16(ifd0Offset);
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = ifd0Offset + 2 + i * 12;
    if (entryOffset + 12 > tiffBytes.length) break;
    const tag = read16(entryOffset);
    const type = read16(entryOffset + 2);
    if (tag === 0x0112) {
      const val = type === 4 ? read32(entryOffset + 8) : read16(entryOffset + 8);
      if (val >= 1 && val <= 8) return val;
    }
  }
  return 1;
}

/**
 * Normalizes EXIF Orientation (0x0112) in IFD0/IFD1 to 1 (upright normal) and swaps
 * coded width/height tags when the original orientation was 90°/270° (5, 6, 7, 8),
 * because browser canvas rendering already bakes pixels in upright display orientation.
 * All other tags — including GPSInfo (0x8825), MakerNote, and ExifSubIFD — remain intact.
 */
export function normalizeExifOrientation(tiffBytes) {
  if (!tiffBytes || tiffBytes.length < 8) return tiffBytes;
  const endian = bytesToAscii(tiffBytes, 0, 2);
  const le = endian === 'II';
  if (!le && endian !== 'MM') return tiffBytes;

  const out = tiffBytes.slice();
  const read16 = (off) =>
    le
      ? (out[off] | (out[off + 1] << 8)) >>> 0
      : ((out[off] << 8) | out[off + 1]) >>> 0;
  const write16 = (off, val) => {
    if (le) {
      out[off] = val & 0xff;
      out[off + 1] = (val >>> 8) & 0xff;
    } else {
      out[off] = (val >>> 8) & 0xff;
      out[off + 1] = val & 0xff;
    }
  };
  const read32 = (off) => (le ? readU32LE(out, off) : readU32BE(out, off));
  const write32 = (off, val) => (le ? writeU32LE(out, off, val) : writeU32BE(out, off, val));

  if (read16(2) !== 42) return out;
  const ifd0Offset = read32(4);
  if (ifd0Offset + 2 > out.length) return out;

  const isScalarEntry = (entryOffset) => {
    const type = read16(entryOffset + 2);
    const count = read32(entryOffset + 4);
    return (type === 3 || type === 4) && count === 1;
  };
  const readScalarEntry = (entryOffset) => {
    const type = read16(entryOffset + 2);
    return type === 3 ? read16(entryOffset + 8) : read32(entryOffset + 8);
  };
  const writeScalarEntry = (entryOffset, val) => {
    if (!isScalarEntry(entryOffset)) return;
    const type = read16(entryOffset + 2);
    if (type === 3) {
      write16(entryOffset + 8, val);
      write16(entryOffset + 10, 0);
    } else {
      write32(entryOffset + 8, val);
    }
  };

  let origOrientation = 1;
  let widthEntryPos = -1;
  let heightEntryPos = -1;
  let exifSubIfdOffset = 0;
  let gpsIfdOffset = 0;

  const numEntries0 = read16(ifd0Offset);
  if (numEntries0 > 256 || ifd0Offset + 2 + numEntries0 * 12 > out.length) return tiffBytes;

  for (let i = 0; i < numEntries0; i++) {
    const entryOffset = ifd0Offset + 2 + i * 12;
    if (entryOffset + 12 > out.length) break;
    const tag = read16(entryOffset);
    if (tag === 0x0112 && isScalarEntry(entryOffset)) {
      origOrientation = readScalarEntry(entryOffset);
      writeScalarEntry(entryOffset, 1);
    } else if (tag === 0x0100 && isScalarEntry(entryOffset)) {
      widthEntryPos = entryOffset;
    } else if (tag === 0x0101 && isScalarEntry(entryOffset)) {
      heightEntryPos = entryOffset;
    } else if (tag === 0x8769) {
      exifSubIfdOffset = readScalarEntry(entryOffset);
    } else if (tag === 0x8825) {
      gpsIfdOffset = readScalarEntry(entryOffset);
    }
  }

  // If original orientation rotated 90°/270° (5..8), swap coded width/height tags to match upright pixels
  if (origOrientation >= 5 && origOrientation <= 8) {
    if (widthEntryPos >= 0 && heightEntryPos >= 0) {
      const wVal = readScalarEntry(widthEntryPos);
      const hVal = readScalarEntry(heightEntryPos);
      writeScalarEntry(widthEntryPos, hVal);
      writeScalarEntry(heightEntryPos, wVal);
    }
    if (exifSubIfdOffset > 0 && exifSubIfdOffset + 2 <= out.length) {
      const subEntries = read16(exifSubIfdOffset);
      if (subEntries > 0 && subEntries <= 256 && exifSubIfdOffset + 2 + subEntries * 12 <= out.length) {
        let subWPos = -1;
        let subHPos = -1;
        for (let i = 0; i < subEntries; i++) {
          const entryOffset = exifSubIfdOffset + 2 + i * 12;
          const tag = read16(entryOffset);
          if (tag === 0x0112) writeScalarEntry(entryOffset, 1);
          else if (tag === 0xa002 && isScalarEntry(entryOffset)) subWPos = entryOffset;
          else if (tag === 0xa003 && isScalarEntry(entryOffset)) subHPos = entryOffset;
        }
        if (subWPos >= 0 && subHPos >= 0) {
          const sw = readScalarEntry(subWPos);
          const sh = readScalarEntry(subHPos);
          writeScalarEntry(subWPos, sh);
          writeScalarEntry(subHPos, sw);
        }
      }
    }
  }

  return out;
}

/**
 * Ensures that a raw EXIF TIFF buffer contains a valid, decodable GPSInfo (0x8825) Sub-IFD in IFD0
 * whenever valid GPS coordinates are available (e.g. from XMP, a secondary APP1 segment, or ExifSubIFD).
 * If IFD0 already has a valid GPSInfo Sub-IFD, returns tiffBytes untouched so all original GPS tags remain intact.
 * Otherwise appends the GPSInfo Sub-IFD at the end of the TIFF buffer without shifting any existing offsets.
 */
export function ensureExifGpsInTiff(tiffBytes, gps) {
  const hasValidGps =
    gps &&
    typeof gps.latitude === 'number' &&
    typeof gps.longitude === 'number' &&
    !Number.isNaN(gps.latitude) &&
    !Number.isNaN(gps.longitude);
  if (!hasValidGps) return tiffBytes;

  if (!tiffBytes || tiffBytes.length < 8) {
    return buildExifTiffPayload({ gps });
  }

  // If IFD0 already contains a valid decodable GPSInfo Sub-IFD, keep it byte-for-byte intact
  if (parseExifGps(tiffBytes, { ifd0Only: true })) {
    return tiffBytes;
  }

  const endian = bytesToAscii(tiffBytes, 0, 2);
  const le = endian === 'II';
  if (!le && endian !== 'MM') return tiffBytes;

  const read16 = (buf, off) =>
    le
      ? (buf[off] | (buf[off + 1] << 8)) >>> 0
      : ((buf[off] << 8) | buf[off + 1]) >>> 0;
  const write16 = (buf, off, val) => {
    if (le) {
      buf[off] = val & 0xff;
      buf[off + 1] = (val >>> 8) & 0xff;
    } else {
      buf[off] = (val >>> 8) & 0xff;
      buf[off + 1] = val & 0xff;
    }
  };
  const read32 = (buf, off) => (le ? readU32LE(buf, off) : readU32BE(buf, off));
  const write32 = (buf, off, val) => (le ? writeU32LE(buf, off, val) : writeU32BE(buf, off, val));

  if (read16(tiffBytes, 2) !== 42) return tiffBytes;
  const ifd0Offset = read32(tiffBytes, 4);
  if (ifd0Offset + 2 > tiffBytes.length) return tiffBytes;
  const numEntries0 = read16(tiffBytes, ifd0Offset);
  if (numEntries0 > 256 || ifd0Offset + 2 + numEntries0 * 12 + 4 > tiffBytes.length) {
    return tiffBytes;
  }

  let existingGpsEntryOff = -1;
  for (let i = 0; i < numEntries0; i++) {
    const entryOff = ifd0Offset + 2 + i * 12;
    if (read16(tiffBytes, entryOff) === 0x8825) {
      existingGpsEntryOff = entryOff;
      break;
    }
  }

  const hasAlt = typeof gps.altitude === 'number' && !Number.isNaN(gps.altitude);
  const gpsEntriesCount = hasAlt ? 7 : 5;
  const gpsIfdSize = 2 + gpsEntriesCount * 12 + 4;
  const totalGpsLen = gpsIfdSize + 48 + (hasAlt ? 8 : 0);

  const buildGpsBlockAt = (gpsBaseOffset) => {
    const latOffset = gpsBaseOffset + gpsIfdSize;
    const lonOffset = latOffset + 24;
    const altOffset = lonOffset + 24;
    const block = new Uint8Array(totalGpsLen);
    write16(block, 0, gpsEntriesCount);

    const latRefChar = gps.latitude < 0 ? 'S' : 'N';
    const lonRefChar = gps.longitude < 0 ? 'W' : 'E';
    const gpsTags = [
      { tag: 0x0000, type: 1, count: 4, inlineBytes: [2, 3, 0, 0] },
      { tag: 0x0001, type: 2, count: 2, inlineBytes: [latRefChar.charCodeAt(0), 0, 0, 0] },
      { tag: 0x0002, type: 5, count: 3, offset: latOffset },
      { tag: 0x0003, type: 2, count: 2, inlineBytes: [lonRefChar.charCodeAt(0), 0, 0, 0] },
      { tag: 0x0004, type: 5, count: 3, offset: lonOffset },
    ];
    if (hasAlt) {
      const altBelow = gps.altitude < 0 ? 1 : 0;
      gpsTags.push(
        { tag: 0x0005, type: 1, count: 1, inlineBytes: [altBelow, 0, 0, 0] },
        { tag: 0x0006, type: 5, count: 1, offset: altOffset }
      );
    }

    gpsTags.forEach((gt, idx) => {
      const pos = 2 + idx * 12;
      write16(block, pos, gt.tag);
      write16(block, pos + 2, gt.type);
      write32(block, pos + 4, gt.count);
      if (gt.inlineBytes) {
        block.set(gt.inlineBytes, pos + 8);
      } else {
        write32(block, pos + 8, gt.offset);
      }
    });

    const writeDmsAt = (targetOff, dec) => {
      const abs = Math.abs(dec);
      const deg = Math.floor(abs);
      const minFloat = (abs - deg) * 60;
      const min = Math.floor(minFloat);
      const secNum = Math.round((minFloat - min) * 60 * 10000);
      write32(block, targetOff, deg);
      write32(block, targetOff + 4, 1);
      write32(block, targetOff + 8, min);
      write32(block, targetOff + 12, 1);
      write32(block, targetOff + 16, secNum);
      write32(block, targetOff + 20, 10000);
    };

    writeDmsAt(gpsIfdSize, gps.latitude);
    writeDmsAt(gpsIfdSize + 24, gps.longitude);
    if (hasAlt) {
      const altNum = Math.round(Math.abs(gps.altitude) * 100);
      write32(block, gpsIfdSize + 48, altNum);
      write32(block, gpsIfdSize + 52, 100);
    }
    return block;
  };

  // Trim trailing zero padding if appending the GPS block would exceed the 64 KB APP1 limit (0xfff7)
  let baseLen = tiffBytes.length;
  const minEnd = ifd0Offset + 2 + numEntries0 * 12 + 4;
  if (((baseLen + 1) & ~1) + totalGpsLen + 2 + (numEntries0 + 1) * 12 + 4 > 0xfff7) {
    while (baseLen > minEnd && tiffBytes[baseLen - 1] === 0) {
      baseLen--;
    }
  }

  if (existingGpsEntryOff >= 0) {
    const gpsBaseOffset = (baseLen + 1) & ~1;
    if (gpsBaseOffset + totalGpsLen > 0xfff7) return tiffBytes;
    const out = new Uint8Array(gpsBaseOffset + totalGpsLen);
    out.set(tiffBytes.subarray(0, baseLen), 0);
    out.set(buildGpsBlockAt(gpsBaseOffset), gpsBaseOffset);
    write16(out, existingGpsEntryOff + 2, 4);
    write32(out, existingGpsEntryOff + 4, 1);
    write32(out, existingGpsEntryOff + 8, gpsBaseOffset);
    return out;
  }

  // Relocate IFD0 to end of TIFF buffer with added 0x8825 entry so zero existing offsets shift
  const newIfd0Offset = (baseLen + 1) & ~1;
  const newNumEntries = numEntries0 + 1;
  const newIfd0Size = 2 + newNumEntries * 12 + 4;
  const gpsBaseOffset = newIfd0Offset + newIfd0Size;
  if (gpsBaseOffset + totalGpsLen > 0xfff7) return tiffBytes;

  const out = new Uint8Array(gpsBaseOffset + totalGpsLen);
  out.set(tiffBytes.subarray(0, baseLen), 0);
  write32(out, 4, newIfd0Offset);
  write16(out, newIfd0Offset, newNumEntries);

  let inserted = false;
  let dstIdx = 0;
  for (let i = 0; i < numEntries0; i++) {
    const srcOff = ifd0Offset + 2 + i * 12;
    const tag = read16(tiffBytes, srcOff);
    if (!inserted && tag > 0x8825) {
      const gpsEntryOff = newIfd0Offset + 2 + dstIdx * 12;
      write16(out, gpsEntryOff, 0x8825);
      write16(out, gpsEntryOff + 2, 4);
      write32(out, gpsEntryOff + 4, 1);
      write32(out, gpsEntryOff + 8, gpsBaseOffset);
      inserted = true;
      dstIdx++;
    }
    out.set(tiffBytes.subarray(srcOff, srcOff + 12), newIfd0Offset + 2 + dstIdx * 12);
    dstIdx++;
  }
  if (!inserted) {
    const gpsEntryOff = newIfd0Offset + 2 + dstIdx * 12;
    write16(out, gpsEntryOff, 0x8825);
    write16(out, gpsEntryOff + 2, 4);
    write32(out, gpsEntryOff + 4, 1);
    write32(out, gpsEntryOff + 8, gpsBaseOffset);
  }

  const oldNextIfdPos = ifd0Offset + 2 + numEntries0 * 12;
  const newNextIfdPos = newIfd0Offset + 2 + newNumEntries * 12;
  out.set(tiffBytes.subarray(oldNextIfdPos, oldNextIfdPos + 4), newNextIfdPos);
  out.set(buildGpsBlockAt(gpsBaseOffset), gpsBaseOffset);
  return out;
}

/**
 * Normalizes XMP tiff:Orientation / exif:Orientation attribute or element to "1" (upright normal).
 */
export function normalizeXmpOrientation(xmpBytes) {
  if (!xmpBytes || xmpBytes.length === 0) return xmpBytes;
  const xml = textDecoder.decode(xmpBytes);
  const updated = xml
    .replace(/((?:tiff|exif):Orientation\s*=\s*(["']))[1-8]\2/gi, '$11$2')
    .replace(/(<(?:tiff|exif):Orientation>\s*)[1-8](\s*<\/(?:tiff|exif):Orientation>)/gi, '$11$2');
  return updated === xml ? xmpBytes : textEncoder.encode(updated);
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

  const bundle = {
    format,
    fileName: fileName || '',
    originalFileName: fileName || '',
    title: '',
    hasMetadata: false,
    hasGps: false,
    gps: null,
    gpsRedactedByOs: false,
    tagsSummary: [],
    jpegSegments: [],
    pngChunks: [],
    webpChunks: [],
    rawExifTiff: null,
    rawXmp: null,
    rawIcc: null,
  };

  let sawRedactedGpsIfd = false;

  const addTag = (tag) => {
    if (!bundle.tagsSummary.includes(tag)) bundle.tagsSummary.push(tag);
  };

  const inspectExifTiff = (tiffSlice) => {
    const gpsInfo = parseExifGps(tiffSlice);
    if (!bundle.rawExifTiff || (!bundle.gps && gpsInfo)) {
      bundle.rawExifTiff = tiffSlice;
    }
    addTag('EXIF');
    const exifTitle = parseExifTitle(tiffSlice);
    if (exifTitle && !bundle.title) {
      bundle.title = exifTitle;
      addTag('Title');
    }
    if (gpsInfo) {
      bundle.hasGps = true;
      bundle.gps = gpsInfo;
      addTag('GPS');
    } else if (hasRedactedExifGpsIfd(tiffSlice)) {
      sawRedactedGpsIfd = true;
    }
  };

  const inspectXmpBytes = (xmpSlice) => {
    if (!bundle.rawXmp) {
      bundle.rawXmp = xmpSlice;
    }
    addTag('XMP');
    const xmpTitle = parseXmpTitle(xmpSlice);
    if (xmpTitle && !bundle.title) {
      bundle.title = xmpTitle;
      addTag('Title');
    }
    const xmpGps = parseXmpGps(xmpSlice);
    if (xmpGps) {
      bundle.hasGps = true;
      if (!bundle.gps) bundle.gps = xmpGps;
      addTag('GPS');
    }
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
      // Skip APP2 Multi-Picture Format ("MPF\0") index segments whose trailing image offsets become invalid after canvas re-encoding
      const isMpfApp2 =
        marker === 0xe2 &&
        payload.length >= 4 &&
        payload[0] === 0x4d &&
        payload[1] === 0x50 &&
        payload[2] === 0x46 &&
        payload[3] === 0x00;

      if ((isAppMetadata || isComment) && !isMpfApp2) {
        bundle.jpegSegments.push(fullSegment);
        bundle.hasMetadata = true;

        if (marker === 0xe1) {
          if (isExifApp1Payload(payload)) {
            inspectExifTiff(payload.slice(6));
          } else if (startsWithBytes(payload, xmpPrefix)) {
            inspectXmpBytes(payload.slice(xmpPrefix.length));
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
          const tiffSlice = isExifApp1Payload(data) ? data.slice(6) : data;
          inspectExifTiff(tiffSlice);
        } else if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
          const nulIdx = data.indexOf(0);
          const keyword = nulIdx > 0 ? bytesToAscii(data, 0, nulIdx) : '';
          if (keyword === 'XML:com.adobe.xmp') {
            // In iTXt, 5 bytes follow the keyword before UTF-8 XML
            const xmlStart = type === 'iTXt' ? Math.min(data.length, nulIdx + 5) : nulIdx + 1;
            inspectXmpBytes(data.slice(xmlStart));
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
          const tiffSlice = isExifApp1Payload(data) ? data.slice(6) : data;
          inspectExifTiff(tiffSlice);
        } else if (fourCC === 'XMP ') {
          inspectXmpBytes(data);
        } else if (fourCC === 'ICCP') {
          bundle.rawIcc = data;
          addTag('ICC');
        }
      }

      offset = dataEnd + (chunkSize & 1);
    }
  }

  // If the file came from a mobile OS photo picker that replaced the filename with a synthetic numeric ID,
  // recover the original filename from embedded EXIF/XMP metadata when available.
  const resolvedName = fileName
    ? resolveOriginalFileName(fileName, bundle.rawExifTiff, bundle.rawXmp)
    : '';
  if (resolvedName) {
    bundle.fileName = resolvedName;
    bundle.originalFileName = resolvedName;
  }

  const cleanFileTitle = bundle.fileName ? bundle.fileName.replace(/\.[^/.]+$/, '') : '';
  if (!bundle.title && cleanFileTitle) {
    bundle.title = cleanFileTitle;
  }

  if (!bundle.hasGps && sawRedactedGpsIfd) {
    bundle.gpsRedactedByOs = true;
  }

  bundle.orientation = bundle.rawExifTiff ? parseExifOrientation(bundle.rawExifTiff) : 1;

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
 * Automatically normalizes EXIF & XMP Orientation tags to 1 (upright normal) because
 * the canvas-encoded pixel stream is already oriented upright by the browser,
 * while guaranteeing GPSInfo (0x8825) and all camera/artist/color metadata remain intact.
 */
export function injectImageMetadataBytes(buffer, metadataBundle, targetMime = '') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0);
  if (!metadataBundle) return bytes;

  const format =
    detectImageMime(bytes) !== 'unknown' ? detectImageMime(bytes) : targetMime;
  const xmpPrefix = asciiToBytes(XMP_HEADER_STR);

  if (format === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let segmentsToInject = [];

    if (metadataBundle.jpegSegments && metadataBundle.jpegSegments.length > 0) {
      let hasExifApp1 = false;
      const exifApp1WithGps = [];
      const exifApp1WithoutGps = [];
      const otherSegments = [];

      for (const seg of metadataBundle.jpegSegments) {
        if (
          seg.length >= 8 &&
          seg[0] === 0xff &&
          seg[1] === 0xe2 &&
          seg[4] === 0x4d &&
          seg[5] === 0x50 &&
          seg[6] === 0x46 &&
          seg[7] === 0x00
        ) {
          continue; // Skip broken APP2 "MPF\0" segments
        }
        if (seg.length >= 10 && seg[0] === 0xff && seg[1] === 0xe1) {
          const payload = seg.slice(4);
          if (isExifApp1Payload(payload)) {
            hasExifApp1 = true;
            const normTiff = ensureExifGpsInTiff(
              normalizeExifOrientation(payload.slice(6)),
              metadataBundle.gps
            );
            const built =
              createJpegSegment(0xe1, concatUint8Arrays([EXIF_HEADER, normTiff])) || seg;
            if (parseExifGps(normTiff, { ifd0Only: true })) {
              exifApp1WithGps.push(built);
            } else {
              exifApp1WithoutGps.push(built);
            }
            continue;
          }
          if (startsWithBytes(payload, xmpPrefix)) {
            const normXmp = normalizeXmpOrientation(payload.slice(xmpPrefix.length));
            otherSegments.push(
              createJpegSegment(0xe1, concatUint8Arrays([xmpPrefix, normXmp])) || seg
            );
            continue;
          }
        }
        otherSegments.push(seg);
      }

      if (!hasExifApp1 && ((metadataBundle.rawExifTiff && metadataBundle.rawExifTiff.length > 0) || metadataBundle.gps)) {
        const normTiff = ensureExifGpsInTiff(
          normalizeExifOrientation(metadataBundle.rawExifTiff),
          metadataBundle.gps
        );
        const seg = createJpegSegment(0xe1, concatUint8Arrays([EXIF_HEADER, normTiff]));
        if (seg) exifApp1WithGps.push(seg);
      }

      // Place GPS-bearing APP1 Exif segment(s) first right after SOI (0xFF 0xD8) per Exif 2.32 Section 4.5.4
      segmentsToInject = [...exifApp1WithGps, ...exifApp1WithoutGps, ...otherSegments];
    } else {
      if ((metadataBundle.rawExifTiff && metadataBundle.rawExifTiff.length > 0) || metadataBundle.gps) {
        const normTiff = ensureExifGpsInTiff(
          normalizeExifOrientation(metadataBundle.rawExifTiff),
          metadataBundle.gps
        );
        const payload = concatUint8Arrays([EXIF_HEADER, normTiff]);
        const seg = createJpegSegment(0xe1, payload);
        if (seg) segmentsToInject.push(seg);
      }
      if (metadataBundle.rawXmp && metadataBundle.rawXmp.length > 0) {
        const normXmp = normalizeXmpOrientation(metadataBundle.rawXmp);
        const payload = concatUint8Arrays([xmpPrefix, normXmp]);
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

    // Per Exif 2.32 / DCF specification (Section 4.5.4), APP1 EXIF must immediately
    // follow SOI (0xFF 0xD8) at offset 2 without a conflicting JFIF APP0 header so all
    // OS & Gallery GPS readers recognize the Exif & GPSInfo tags.
    const hasApp1 = segmentsToInject.some((s) => s.length >= 2 && s[0] === 0xff && s[1] === 0xe1);
    let bodyStart = 2;
    if (
      hasApp1 &&
      cleanJpeg.length >= 6 &&
      cleanJpeg[2] === 0xff &&
      cleanJpeg[3] === 0xe0
    ) {
      const app0Len = readU16BE(cleanJpeg, 4);
      if (app0Len >= 2 && 4 + app0Len <= cleanJpeg.length) {
        bodyStart = 4 + app0Len;
      }
    }

    return concatUint8Arrays([
      cleanJpeg.slice(0, 2),
      ...segmentsToInject,
      cleanJpeg.slice(bodyStart),
    ]);
  }

  if (format === 'image/png' && startsWithBytes(bytes, PNG_SIGNATURE)) {
    let chunksToInsert = [];

    if (metadataBundle.pngChunks && metadataBundle.pngChunks.length > 0) {
      let hasExifChunk = false;
      chunksToInsert = metadataBundle.pngChunks.map((c) => {
        if (c.type === 'eXIf' && c.data && c.data.length > 0) {
          hasExifChunk = true;
          const rawTiff = isExifApp1Payload(c.data) ? c.data.slice(6) : c.data;
          return createPngChunk(
            'eXIf',
            ensureExifGpsInTiff(normalizeExifOrientation(rawTiff), metadataBundle.gps)
          );
        }
        if ((c.type === 'iTXt' || c.type === 'tEXt') && c.data && c.data.length > 0) {
          const normData = normalizeXmpOrientation(c.data);
          if (normData !== c.data) {
            return createPngChunk(c.type, normData);
          }
        }
        return c.rawChunk;
      });
      if (!hasExifChunk && ((metadataBundle.rawExifTiff && metadataBundle.rawExifTiff.length > 0) || metadataBundle.gps)) {
        chunksToInsert.unshift(
          createPngChunk(
            'eXIf',
            ensureExifGpsInTiff(normalizeExifOrientation(metadataBundle.rawExifTiff), metadataBundle.gps)
          )
        );
      }
    } else {
      if ((metadataBundle.rawExifTiff && metadataBundle.rawExifTiff.length > 0) || metadataBundle.gps) {
        chunksToInsert.push(
          createPngChunk(
            'eXIf',
            ensureExifGpsInTiff(normalizeExifOrientation(metadataBundle.rawExifTiff), metadataBundle.gps)
          )
        );
      }
      if (metadataBundle.rawXmp && metadataBundle.rawXmp.length > 0) {
        chunksToInsert.push(
          createPngITXtChunk('XML:com.adobe.xmp', normalizeXmpOrientation(metadataBundle.rawXmp))
        );
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
      let hasWebpExif = false;
      for (const c of metadataBundle.webpChunks) {
        let chunkData = c.data;
        if (c.fourCC === 'EXIF' && chunkData && chunkData.length > 0) {
          hasWebpExif = true;
          const rawTiff = isExifApp1Payload(chunkData) ? chunkData.slice(6) : chunkData;
          const normTiff = ensureExifGpsInTiff(
            normalizeExifOrientation(rawTiff),
            metadataBundle.gps
          );
          chunkData = isExifApp1Payload(chunkData)
            ? concatUint8Arrays([EXIF_HEADER, normTiff])
            : normTiff;
        } else if (c.fourCC === 'XMP ' && chunkData && chunkData.length > 0) {
          chunkData = normalizeXmpOrientation(chunkData);
        }
        metaChunks.push({ fourCC: c.fourCC, data: chunkData });
        if (c.fourCC === 'ICCP') flagsMask |= 0x20;
        if (c.fourCC === 'EXIF') flagsMask |= 0x08;
        if (c.fourCC === 'XMP ') flagsMask |= 0x04;
      }
      if (!hasWebpExif && ((metadataBundle.rawExifTiff && metadataBundle.rawExifTiff.length > 0) || metadataBundle.gps)) {
        metaChunks.push({
          fourCC: 'EXIF',
          data: ensureExifGpsInTiff(
            normalizeExifOrientation(metadataBundle.rawExifTiff),
            metadataBundle.gps
          ),
        });
        flagsMask |= 0x08;
      }
    } else {
      if (metadataBundle.rawIcc && metadataBundle.rawIcc.length > 0) {
        metaChunks.push({ fourCC: 'ICCP', data: metadataBundle.rawIcc });
        flagsMask |= 0x20;
      }
      if ((metadataBundle.rawExifTiff && metadataBundle.rawExifTiff.length > 0) || metadataBundle.gps) {
        metaChunks.push({
          fourCC: 'EXIF',
          data: ensureExifGpsInTiff(
            normalizeExifOrientation(metadataBundle.rawExifTiff),
            metadataBundle.gps
          ),
        });
        flagsMask |= 0x08;
      }
      if (metadataBundle.rawXmp && metadataBundle.rawXmp.length > 0) {
        metaChunks.push({
          fourCC: 'XMP ',
          data: normalizeXmpOrientation(metadataBundle.rawXmp),
        });
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

  const baseName = originalFileName.trim().split(/[/\\]/).pop()?.trim() || '';
  if (!baseName) return fallback;

  const extMatch = baseName.match(/^(.*)\.([^.]+)$/);
  if (!extMatch) {
    return `${baseName}.${targetExt || 'png'}`;
  }

  const stem = extMatch[1] || baseName;
  const origExt = extMatch[2];
  const origExtLower = origExt.toLowerCase();

  const mimeMatchesExt =
    !targetMime ||
    (targetMime === 'image/jpeg' && (origExtLower === 'jpg' || origExtLower === 'jpeg')) ||
    (targetMime === 'image/png' && origExtLower === 'png') ||
    (targetMime === 'image/webp' && origExtLower === 'webp') ||
    (originalMime && targetMime === originalMime);

  if (mimeMatchesExt) {
    return baseName;
  }

  return `${stem}.${targetExt || origExtLower}`;
}

/**
 * Converts a decimal degree value into 3 unsigned [numerator, denominator] RATIONAL pairs [deg, min, sec].
 */
function decimalDegreesToDmsRationals(dec) {
  const abs = Math.abs(dec);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const secNum = Math.round((minFloat - min) * 60 * 10000);
  const buf = new Uint8Array(24);
  writeU32LE(buf, 0, deg);
  writeU32LE(buf, 4, 1);
  writeU32LE(buf, 8, min);
  writeU32LE(buf, 12, 1);
  writeU32LE(buf, 16, secNum);
  writeU32LE(buf, 20, 10000);
  return buf;
}

/**
 * Builds a valid EXIF TIFF payload with ImageDescription (Title), Make, Model, Artist,
 * and optional Orientation (0x0112), dimensions (0x0100, 0x0101), DocumentName (0x010D),
 * DateTime (0x0132), and GPSInfo Sub-IFD (0x8825) for tests and verification.
 */
export function buildExifTiffPayload({
  title = 'Midnight Neon Kiosk',
  artist = 'Halation Studio Photographer',
  make = 'Leica Camera AG',
  model = 'Leica M6 TTL 35mm',
  orientation = null,
  width = null,
  height = null,
  documentName = null,
  dateTime = null,
  gps = null,
} = {}) {
  // Little-endian TIFF ('II', 42, IFD0 at offset 8)
  const entries = [];
  if (typeof width === 'number' && width > 0) {
    entries.push({ tag: 0x0100, type: 4, scalar: width }); // ImageWidth
  }
  if (typeof height === 'number' && height > 0) {
    entries.push({ tag: 0x0101, type: 4, scalar: height }); // ImageLength
  }
  if (typeof documentName === 'string' && documentName.length > 0) {
    entries.push({ tag: 0x010d, type: 2, str: documentName }); // DocumentName
  }
  entries.push(
    { tag: 0x010e, type: 2, str: title }, // ImageDescription (Title)
    { tag: 0x010f, type: 2, str: make },  // Make
    { tag: 0x0110, type: 2, str: model }  // Model
  );
  if (typeof orientation === 'number' && orientation >= 1 && orientation <= 8) {
    entries.push({ tag: 0x0112, type: 3, scalar: orientation }); // Orientation (SHORT)
  }
  if (typeof dateTime === 'string' && dateTime.length > 0) {
    entries.push({ tag: 0x0132, type: 2, str: dateTime }); // DateTime
  }
  entries.push({ tag: 0x013b, type: 2, str: artist }); // Artist

  const hasGps =
    gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number';
  if (hasGps) {
    entries.push({ tag: 0x8825, type: 4, isGpsPtr: true, scalar: 0 }); // GPSInfoIFDPointer
  }

  const ifdSize = 2 + entries.length * 12 + 4;
  let dataOffset = 8 + ifdSize;
  const prepared = entries.map((e) => {
    if (e.type !== 2) {
      return { tag: e.tag, type: e.type, count: 1, scalar: e.scalar, isGpsPtr: Boolean(e.isGpsPtr) };
    }
    const bytes = textEncoder.encode(e.str + '\0');
    const pad = bytes.length & 1 ? 1 : 0;
    const buf = new Uint8Array(bytes.length + pad);
    buf.set(bytes, 0);
    const item = { tag: e.tag, type: 2, count: bytes.length, offset: dataOffset, buf };
    dataOffset += buf.length;
    return item;
  });

  let gpsBlock = null;
  let gpsIfdOffset = 0;
  if (hasGps) {
    gpsIfdOffset = dataOffset;
    const gpsEntriesCount = typeof gps.altitude === 'number' ? 7 : 5;
    const gpsIfdSize = 2 + gpsEntriesCount * 12 + 4;
    const latOffset = gpsIfdOffset + gpsIfdSize;
    const lonOffset = latOffset + 24;
    const altOffset = lonOffset + 24;
    const totalGpsLen = gpsIfdSize + 48 + (typeof gps.altitude === 'number' ? 8 : 0);

    gpsBlock = new Uint8Array(totalGpsLen);
    gpsBlock[0] = gpsEntriesCount;
    gpsBlock[1] = 0;

    const latRefChar = gps.latitude < 0 ? 'S' : 'N';
    const lonRefChar = gps.longitude < 0 ? 'W' : 'E';
    const gpsTags = [
      // 0x0000 GPSVersionID (BYTE, count 4, inline 2.3.0.0)
      { tag: 0x0000, type: 1, count: 4, inlineBytes: [2, 3, 0, 0] },
      // 0x0001 GPSLatitudeRef (ASCII, count 2, inline)
      { tag: 0x0001, type: 2, count: 2, inlineBytes: [latRefChar.charCodeAt(0), 0, 0, 0] },
      // 0x0002 GPSLatitude (RATIONAL, count 3, offset latOffset)
      { tag: 0x0002, type: 5, count: 3, offset: latOffset },
      // 0x0003 GPSLongitudeRef (ASCII, count 2, inline)
      { tag: 0x0003, type: 2, count: 2, inlineBytes: [lonRefChar.charCodeAt(0), 0, 0, 0] },
      // 0x0004 GPSLongitude (RATIONAL, count 3, offset lonOffset)
      { tag: 0x0004, type: 5, count: 3, offset: lonOffset },
    ];
    if (typeof gps.altitude === 'number') {
      const altBelow = gps.altitude < 0 ? 1 : 0;
      gpsTags.push(
        { tag: 0x0005, type: 1, count: 1, inlineBytes: [altBelow, 0, 0, 0] },
        { tag: 0x0006, type: 5, count: 1, offset: altOffset }
      );
    }

    gpsTags.forEach((gt, idx) => {
      const pos = 2 + idx * 12;
      gpsBlock[pos] = gt.tag & 0xff;
      gpsBlock[pos + 1] = (gt.tag >>> 8) & 0xff;
      gpsBlock[pos + 2] = gt.type & 0xff;
      gpsBlock[pos + 3] = 0;
      writeU32LE(gpsBlock, pos + 4, gt.count);
      if (gt.inlineBytes) {
        gpsBlock.set(gt.inlineBytes, pos + 8);
      } else {
        writeU32LE(gpsBlock, pos + 8, gt.offset);
      }
    });

    gpsBlock.set(decimalDegreesToDmsRationals(gps.latitude), gpsIfdSize);
    gpsBlock.set(decimalDegreesToDmsRationals(gps.longitude), gpsIfdSize + 24);
    if (typeof gps.altitude === 'number') {
      const altNum = Math.round(Math.abs(gps.altitude) * 100);
      writeU32LE(gpsBlock, gpsIfdSize + 48, altNum);
      writeU32LE(gpsBlock, gpsIfdSize + 52, 100);
    }

    dataOffset += totalGpsLen;
  }

  const out = new Uint8Array(dataOffset);
  // 'II' + 42 + offset 8
  out[0] = 0x49;
  out[1] = 0x49;
  out[2] = 0x2a;
  out[3] = 0x00;
  writeU32LE(out, 4, 8);

  // Number of entries
  out[8] = prepared.length & 0xff;
  out[9] = (prepared.length >>> 8) & 0xff;

  prepared.forEach((item, idx) => {
    const pos = 10 + idx * 12;
    out[pos] = item.tag & 0xff;
    out[pos + 1] = (item.tag >>> 8) & 0xff;
    out[pos + 2] = item.type & 0xff;
    out[pos + 3] = 0;
    writeU32LE(out, pos + 4, item.count);
    if (item.isGpsPtr) {
      writeU32LE(out, pos + 8, gpsIfdOffset);
    } else if (item.type === 3) {
      out[pos + 8] = item.scalar & 0xff;
      out[pos + 9] = (item.scalar >>> 8) & 0xff;
    } else if (item.type === 4) {
      writeU32LE(out, pos + 8, item.scalar);
    } else if (item.count <= 4) {
      out.set(item.buf.slice(0, item.count), pos + 8);
    } else {
      writeU32LE(out, pos + 8, item.offset);
      out.set(item.buf, item.offset);
    }
  });

  if (gpsBlock) {
    out.set(gpsBlock, gpsIfdOffset);
  }

  return out;
}


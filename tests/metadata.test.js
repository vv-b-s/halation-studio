import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectImageMime,
  extractImageMetadata,
  injectImageMetadataBytes,
  stripImageMetadataBytes,
  processExportBlobMetadata,
  getExactExportFilename,
  buildExifTiffPayload,
  createPngChunk,
  createPngTextChunk,
  createPngITXtChunk,
  createJpegSegment,
  parseExifTitle,
  parseExifOrientation,
  normalizeExifOrientation,
  normalizeXmpOrientation,
} from '../metadata-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createMinimalJpegBytes() {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, // APP0 JFIF
    0xff, 0xdb, 0x00, 0x43, 0x00,
    ...new Array(64).fill(16), // DQT
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, // SOF0 (1x1)
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xd2, 0xcf, 0x20, // SOS
    0xff, 0xd9, // EOI
  ]);
}

function createMinimalWebpBytes({ withVp8x = false } = {}) {
  // RIFF + size + WEBP + (optional VP8X) + VP8L
  const vp8lData = new Uint8Array([0x2f, 0x00, 0x00, 0x00, 0x00, 0x88, 0x88, 0x08]);
  const vp8lChunk = new Uint8Array(8 + vp8lData.length);
  vp8lChunk.set([0x56, 0x50, 0x38, 0x4c], 0); // 'VP8L'
  vp8lChunk[4] = vp8lData.length;
  vp8lChunk.set(vp8lData, 8);

  const chunks = [];
  if (withVp8x) {
    const vp8xChunk = new Uint8Array(18);
    vp8xChunk.set([0x56, 0x50, 0x38, 0x58], 0); // 'VP8X'
    vp8xChunk[4] = 10; // size 10
    chunks.push(vp8xChunk);
  }
  chunks.push(vp8lChunk);

  let bodyLen = 0;
  for (const c of chunks) bodyLen += c.length;
  const out = new Uint8Array(12 + bodyLen);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  const riffSize = 4 + bodyLen;
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >>> 8) & 0xff;
  out[6] = (riffSize >>> 16) & 0xff;
  out[7] = (riffSize >>> 24) & 0xff;
  out.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
  let pos = 12;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

test('detectImageMime and getExactExportFilename handle all image formats and edge cases', () => {
  assert.equal(detectImageMime(createMinimalJpegBytes()), 'image/jpeg');
  assert.equal(detectImageMime(createMinimalWebpBytes()), 'image/webp');
  assert.equal(detectImageMime(new Uint8Array([1, 2, 3])), 'unknown');

  assert.equal(
    getExactExportFilename('DSC_0142.JPG', 'image/jpeg', 'image/jpeg', 'jpg'),
    'DSC_0142.JPG'
  );
  assert.equal(
    getExactExportFilename('Midnight Kiosk Study.png', 'image/png', 'image/png', 'png'),
    'Midnight Kiosk Study.png'
  );
  assert.equal(
    getExactExportFilename('street_halation.webp', 'image/webp', 'image/webp', 'webp'),
    'street_halation.webp'
  );
  assert.equal(
    getExactExportFilename('DSC_0142.JPG', 'image/jpeg', 'image/png', 'png'),
    'DSC_0142.png'
  );
  assert.equal(
    getExactExportFilename('untitled_roll', 'image/png', 'image/png', 'png'),
    'untitled_roll.png'
  );
  assert.equal(getExactExportFilename('', 'image/png', 'image/png', 'png'), 'photo.png');
  assert.equal(getExactExportFilename('   ', 'image/jpeg', 'image/jpeg', 'jpg'), 'photo.jpg');
});

test('JPEG metadata extraction, injection, and stripping preserve EXIF, XMP, ICC, IPTC, and Comments', () => {
  const baseJpeg = createMinimalJpegBytes();
  const exifTiff = buildExifTiffPayload({
    title: 'Tokyo Rain Halation',
    artist: 'Valentin Vasilev',
    make: 'Leica',
    model: 'Leica MP',
  });
  const exifPayload = new Uint8Array(6 + exifTiff.length);
  exifPayload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);
  exifPayload.set(exifTiff, 6);
  const app1Exif = createJpegSegment(0xe1, exifPayload);

  const xmpXml =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Tokyo Rain Halation</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const xmpBytes = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0' + xmpXml);
  const app1Xmp = createJpegSegment(0xe1, xmpBytes);

  // ICC Profile segment (APP2)
  const iccPayload = new Uint8Array(14 + 16);
  iccPayload.set(new TextEncoder().encode('ICC_PROFILE\0'), 0);
  iccPayload[12] = 1;
  iccPayload[13] = 1;
  iccPayload.fill(0x42, 14);
  const app2Icc = createJpegSegment(0xe2, iccPayload);

  // IPTC segment (APP13) + Comment (COM)
  const app13Iptc = createJpegSegment(0xed, new TextEncoder().encode('Photoshop 3.0\x008BIM'));
  const commentSeg = createJpegSegment(0xfe, new TextEncoder().encode('Shot on CineStill 800T'));

  const uploadJpeg = injectImageMetadataBytes(
    baseJpeg,
    {
      jpegSegments: [app1Exif, app1Xmp, app2Icc, app13Iptc, commentSeg],
    },
    'image/jpeg'
  );

  const extracted = extractImageMetadata(uploadJpeg, 'image/jpeg', 'Tokyo_Rain_01.JPG');
  assert.equal(extracted.format, 'image/jpeg');
  assert.equal(extracted.hasMetadata, true);
  assert.equal(extracted.title, 'Tokyo Rain Halation');
  assert.deepEqual(extracted.tagsSummary, ['EXIF', 'Title', 'XMP', 'ICC', 'IPTC', 'Comment']);
  assert.equal(extracted.jpegSegments.length, 5);

  const exportedJpeg = injectImageMetadataBytes(createMinimalJpegBytes(), extracted, 'image/jpeg');
  const reExtracted = extractImageMetadata(exportedJpeg, 'image/jpeg', 'Tokyo_Rain_01.JPG');
  assert.equal(reExtracted.hasMetadata, true);
  assert.equal(reExtracted.jpegSegments.length, 5);
  assert.deepEqual(reExtracted.rawExifTiff, exifTiff);

  // Strip metadata
  const strippedJpeg = stripImageMetadataBytes(exportedJpeg, 'image/jpeg');
  const afterStrip = extractImageMetadata(strippedJpeg, 'image/jpeg', 'Tokyo_Rain_01.JPG');
  assert.equal(afterStrip.hasMetadata, false);
  assert.equal(afterStrip.jpegSegments.length, 0);
});

test('PNG metadata extraction, injection, and stripping preserve eXIf, tEXt, iTXt, iCCP, pHYs, and tIME chunks', () => {
  const samplePngPath = path.join(__dirname, '..', 'assets', 'examples', 'example1-input.png');
  const rawPng = new Uint8Array(fs.readFileSync(samplePngPath));

  const exifTiff = buildExifTiffPayload({
    title: 'Night Kiosk 35mm',
    artist: 'Studio Test',
    make: 'Hasselblad',
    model: '500C/M',
  });
  const exifChunk = createPngChunk('eXIf', exifTiff);
  const titleChunk = createPngTextChunk('Title', 'Night Kiosk 35mm');
  const authorChunk = createPngTextChunk('Author', 'Studio Test');
  const xmpChunk = createPngITXtChunk(
    'XML:com.adobe.xmp',
    '<x:xmpmeta><dc:title><rdf:Alt><rdf:li>Night Kiosk 35mm</rdf:li></rdf:Alt></dc:title></x:xmpmeta>'
  );
  const physChunk = createPngChunk('pHYs', new Uint8Array([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]));
  const timeChunk = createPngChunk('tIME', new Uint8Array([0x07, 0xea, 11, 17, 12, 30, 0]));

  const richPng = injectImageMetadataBytes(
    rawPng,
    {
      pngChunks: [
        { type: 'eXIf', data: exifTiff, rawChunk: exifChunk },
        { type: 'tEXt', data: new Uint8Array(0), rawChunk: titleChunk },
        { type: 'tEXt', data: new Uint8Array(0), rawChunk: authorChunk },
        { type: 'iTXt', data: new Uint8Array(0), rawChunk: xmpChunk },
        { type: 'pHYs', data: new Uint8Array(0), rawChunk: physChunk },
        { type: 'tIME', data: new Uint8Array(0), rawChunk: timeChunk },
      ],
    },
    'image/png'
  );

  const extracted = extractImageMetadata(richPng, 'image/png', 'Night_Kiosk_35mm.png');
  assert.equal(extracted.hasMetadata, true);
  assert.equal(extracted.title, 'Night Kiosk 35mm');
  assert.ok(extracted.tagsSummary.includes('EXIF'));
  assert.ok(extracted.tagsSummary.includes('XMP'));
  assert.ok(extracted.tagsSummary.includes('pHYs'));
  assert.ok(extracted.tagsSummary.includes('tIME'));

  const cleanBasePng = stripImageMetadataBytes(rawPng, 'image/png');
  const exportedPng = injectImageMetadataBytes(cleanBasePng, extracted, 'image/png');
  const verifyExport = extractImageMetadata(exportedPng, 'image/png', 'Night_Kiosk_35mm.png');
  assert.equal(verifyExport.hasMetadata, true);
  assert.equal(verifyExport.pngChunks.length, 6);

  const strippedPng = stripImageMetadataBytes(exportedPng, 'image/png');
  const verifyStripped = extractImageMetadata(strippedPng, 'image/png', 'Night_Kiosk_35mm.png');
  assert.equal(verifyStripped.hasMetadata, false);
  assert.equal(verifyStripped.pngChunks.length, 0);
});

test('WebP metadata extraction, injection, stripping, and cross-format conversion (JPEG <-> PNG <-> WebP)', async () => {
  const exifTiff = buildExifTiffPayload({
    title: 'Cross Format Film Frame',
    artist: 'Valentin Vasilev',
    make: 'Pentax',
    model: 'Pentax 67II',
  });
  const xmpBytes = new TextEncoder().encode(
    '<x:xmpmeta><dc:title><rdf:Alt><rdf:li>Cross Format Film Frame</rdf:li></rdf:Alt></dc:title></x:xmpmeta>'
  );
  const iccBytes = new Uint8Array([1, 2, 3, 4, 5]); // odd length to test RIFF even-byte padding

  // Inject synthesized EXIF + XMP + ICC into a WebP container (both with and without VP8X)
  const webpSimple = createMinimalWebpBytes({ withVp8x: false });
  const webpWithVp8x = createMinimalWebpBytes({ withVp8x: true });

  const syntheticBundle = {
    title: 'Cross Format Film Frame',
    rawExifTiff: exifTiff,
    rawXmp: xmpBytes,
    rawIcc: iccBytes,
  };

  const injectedWebp1 = injectImageMetadataBytes(webpSimple, syntheticBundle, 'image/webp');
  const injectedWebp2 = injectImageMetadataBytes(webpWithVp8x, syntheticBundle, 'image/webp');

  const extractedWebp = extractImageMetadata(injectedWebp2, 'image/webp', 'frame67.webp');
  assert.equal(extractedWebp.hasMetadata, true);
  assert.equal(extractedWebp.title, 'Cross Format Film Frame');
  assert.deepEqual(extractedWebp.tagsSummary, ['ICC', 'EXIF', 'Title', 'XMP']);

  // Convert WebP metadata -> JPEG
  const convertedJpeg = injectImageMetadataBytes(createMinimalJpegBytes(), extractedWebp, 'image/jpeg');
  const fromConvertedJpeg = extractImageMetadata(convertedJpeg, 'image/jpeg', 'frame67.jpg');
  assert.equal(fromConvertedJpeg.hasMetadata, true);
  assert.equal(fromConvertedJpeg.title, 'Cross Format Film Frame');
  assert.ok(fromConvertedJpeg.tagsSummary.includes('EXIF'));
  assert.ok(fromConvertedJpeg.tagsSummary.includes('XMP'));
  assert.ok(fromConvertedJpeg.tagsSummary.includes('ICC'));

  // Convert JPEG metadata -> PNG via processExportBlobMetadata
  const samplePngPath = path.join(__dirname, '..', 'assets', 'examples', 'example1-input.png');
  const cleanPngBytes = stripImageMetadataBytes(
    new Uint8Array(fs.readFileSync(samplePngPath)),
    'image/png'
  );
  const pngBlob = new Blob([cleanPngBytes], { type: 'image/png' });

  const preservedPngBlob = await processExportBlobMetadata(pngBlob, fromConvertedJpeg, false);
  const preservedPngMeta = extractImageMetadata(
    new Uint8Array(await preservedPngBlob.arrayBuffer()),
    'image/png',
    'frame67.png'
  );
  assert.equal(preservedPngMeta.hasMetadata, true);
  assert.equal(preservedPngMeta.title, 'Cross Format Film Frame');

  const strippedPngBlob = await processExportBlobMetadata(preservedPngBlob, fromConvertedJpeg, true);
  const strippedPngMeta = extractImageMetadata(
    new Uint8Array(await strippedPngBlob.arrayBuffer()),
    'image/png',
    'frame67.png'
  );
  assert.equal(strippedPngMeta.hasMetadata, false);

  // Strip WebP metadata
  const strippedWebp = stripImageMetadataBytes(injectedWebp1, 'image/webp');
  const afterWebpStrip = extractImageMetadata(strippedWebp, 'image/webp', 'frame67.webp');
  assert.equal(afterWebpStrip.hasMetadata, false);
});

test('parseExifTitle supports Big-Endian (MM) TIFF and XPTitle (UTF-16LE)', () => {
  // Construct a minimal Big-Endian ('MM') TIFF with XPTitle (0x9C9B)
  const titleUtf16 = new Uint8Array([0x46, 0x00, 0x69, 0x00, 0x6c, 0x00, 0x6d, 0x00, 0x00, 0x00]); // "Film\0"
  const buf = new Uint8Array(8 + 2 + 12 + 4 + titleUtf16.length);
  buf[0] = 0x4d; // 'M'
  buf[1] = 0x4d; // 'M'
  buf[2] = 0x00;
  buf[3] = 0x2a; // 42
  buf[7] = 8; // IFD0 offset = 8
  buf[8] = 0;
  buf[9] = 1; // 1 entry
  // Entry: tag 0x9C9B, type 1 (BYTE), count 10, offset 26
  buf[10] = 0x9c;
  buf[11] = 0x9b;
  buf[12] = 0x00;
  buf[13] = 0x01;
  buf[17] = titleUtf16.length;
  buf[21] = 26;
  buf.set(titleUtf16, 26);

  assert.equal(parseExifTitle(buf), 'Film');
  assert.equal(parseExifTitle(new Uint8Array([1, 2])), null);
});

test('Horizontal image orientation is preserved by normalizing EXIF & XMP Orientation to 1 on export', () => {
  // 1. Test EXIF Orientation = 6 (90° CW camera sensor -> displayed horizontally upright by browser)
  // with coded sensor dimensions 1080x1920 that swap to 1920x1080 when normalized to Orientation = 1
  const exifRot6 = buildExifTiffPayload({
    title: 'Horizontal Sunset Frame',
    artist: 'Valentin Vasilev',
    make: 'Fujifilm',
    model: 'X100V',
    orientation: 6,
    width: 1080,
    height: 1920,
  });

  assert.equal(parseExifOrientation(exifRot6), 6);

  const normalizedTiff = normalizeExifOrientation(exifRot6);
  assert.equal(parseExifOrientation(normalizedTiff), 1);

  // Verify dimension tags (0x0100 ImageWidth & 0x0101 ImageLength) were swapped to 1920x1080
  const view = new DataView(normalizedTiff.buffer, normalizedTiff.byteOffset, normalizedTiff.byteLength);
  const count = view.getUint16(8, true);
  let widthVal = 0;
  let heightVal = 0;
  for (let i = 0; i < count; i++) {
    const entryOff = 10 + i * 12;
    const tag = view.getUint16(entryOff, true);
    if (tag === 0x0100) widthVal = view.getUint32(entryOff + 8, true);
    if (tag === 0x0101) heightVal = view.getUint32(entryOff + 8, true);
  }
  assert.equal(widthVal, 1920);
  assert.equal(heightVal, 1080);

  // 2. Test JPEG injection normalizes both APP1 EXIF Orientation and APP1 XMP tiff:Orientation
  const exifPayload = new Uint8Array(6 + exifRot6.length);
  exifPayload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);
  exifPayload.set(exifRot6, 6);
  const app1Exif = createJpegSegment(0xe1, exifPayload);

  const xmpWithOrientation =
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description tiff:Orientation="6"><tiff:Orientation>8</tiff:Orientation><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Horizontal Sunset Frame</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>';
  const app1Xmp = createJpegSegment(
    0xe1,
    new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0' + xmpWithOrientation)
  );

  const uploadedJpeg = new Uint8Array([
    0xff, 0xd8,
    ...app1Exif,
    ...app1Xmp,
    ...createMinimalJpegBytes().subarray(2),
  ]);

  const extracted = extractImageMetadata(uploadedJpeg, 'image/jpeg', 'C:\\fakepath\\IMG_4821.JPG');
  assert.equal(extracted.orientation, 6);
  assert.equal(
    getExactExportFilename(extracted.originalFileName, 'image/jpeg', 'image/jpeg', 'jpg'),
    'IMG_4821.JPG'
  );

  const exportedJpeg = injectImageMetadataBytes(createMinimalJpegBytes(), extracted, 'image/jpeg');
  const exportedMeta = extractImageMetadata(exportedJpeg, 'image/jpeg', 'IMG_4821.JPG');
  assert.equal(
    exportedMeta.orientation,
    1,
    'Exported JPEG EXIF Orientation must be normalized to 1 so horizontal images are not rotated sideways'
  );
  const exportedXmpStr = new TextDecoder().decode(exportedMeta.rawXmp);
  assert.ok(exportedXmpStr.includes('tiff:Orientation="1"'));
  assert.ok(exportedXmpStr.includes('<tiff:Orientation>1</tiff:Orientation>'));

  // 3. Verify PNG and WebP exports also normalize EXIF & XMP Orientation to 1
  const samplePngPath = path.join(__dirname, '..', 'assets', 'examples', 'example1-input.png');
  const basePng = stripImageMetadataBytes(new Uint8Array(fs.readFileSync(samplePngPath)), 'image/png');
  const exportedPng = injectImageMetadataBytes(basePng, extracted, 'image/png');
  const exportedPngMeta = extractImageMetadata(exportedPng, 'image/png', 'IMG_4821.png');
  assert.equal(exportedPngMeta.orientation, 1);

  const exportedWebp = injectImageMetadataBytes(
    createMinimalWebpBytes({ withVp8x: true }),
    extracted,
    'image/webp'
  );
  const exportedWebpMeta = extractImageMetadata(exportedWebp, 'image/webp', 'IMG_4821.webp');
  assert.equal(exportedWebpMeta.orientation, 1);

  // 4. Test Big-Endian ('MM') EXIF Orientation = 8 with ExifIFD pointer (0x8769) and PixelXDimension/PixelYDimension (0xA002/0xA003)
  const mmBuf = new Uint8Array(64);
  const mmView = new DataView(mmBuf.buffer);
  mmBuf[0] = 0x4d; // 'M'
  mmBuf[1] = 0x4d; // 'M'
  mmView.setUint16(2, 42, false);
  mmView.setUint32(4, 8, false); // IFD0 at 8
  mmView.setUint16(8, 2, false); // 2 entries in IFD0
  // Entry 0: Orientation (0x0112), SHORT (3), count 1, value 8
  mmView.setUint16(10, 0x0112, false);
  mmView.setUint16(12, 3, false);
  mmView.setUint32(14, 1, false);
  mmView.setUint16(18, 8, false);
  // Entry 1: ExifIFD pointer (0x8769), LONG (4), count 1, offset 38
  mmView.setUint16(22, 0x8769, false);
  mmView.setUint16(24, 4, false);
  mmView.setUint32(26, 1, false);
  mmView.setUint32(30, 38, false);
  mmView.setUint32(34, 0, false); // nextIFD = 0
  // ExifIFD at 38: 2 entries (0xA002 = 1000, 0xA003 = 2000)
  mmView.setUint16(38, 2, false);
  mmView.setUint16(40, 0xa002, false);
  mmView.setUint16(42, 3, false);
  mmView.setUint32(44, 1, false);
  mmView.setUint16(48, 1000, false);
  mmView.setUint16(52, 0xa003, false);
  mmView.setUint16(54, 3, false);
  mmView.setUint32(56, 1, false);
  mmView.setUint16(60, 2000, false);

  assert.equal(parseExifOrientation(mmBuf), 8);
  const mmNorm = normalizeExifOrientation(mmBuf);
  assert.equal(parseExifOrientation(mmNorm), 1);
  const mmNormView = new DataView(mmNorm.buffer);
  assert.equal(mmNormView.getUint16(48, false), 2000);
  assert.equal(mmNormView.getUint16(60, false), 1000);
  assert.deepEqual(normalizeXmpOrientation(new Uint8Array([1, 2])), new Uint8Array([1, 2]));
});


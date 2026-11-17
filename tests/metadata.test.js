import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractImageMetadata,
  injectImageMetadataBytes,
  stripImageMetadataBytes,
  getExactExportFilename,
  buildExifTiffPayload,
  createPngChunk,
  createPngTextChunk,
  createPngITXtChunk,
  createJpegSegment,
  parseExifTitle,
} from '../metadata-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Helper: Creates a minimal valid 1x1 JPEG byte array with APP0 JFIF + DQT + SOF0 + DHT + SOS + EOI.
 */
function createMinimalJpegBytes() {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, // APP0 JFIF
    0xff, 0xdb, 0x00, 0x43, 0x00,
    ...new Array(64).fill(16), // DQT
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, // SOF0 (1x1)
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xd2, 0xcf, 0x20, // SOS + scan data
    0xff, 0xd9, // EOI
  ]);
}

test('getExactExportFilename preserves exact uploaded filename and title when format matches', () => {
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
  // When user explicitly changes export format, stem is preserved with new extension
  assert.equal(
    getExactExportFilename('DSC_0142.JPG', 'image/jpeg', 'image/png', 'png'),
    'DSC_0142.png'
  );
});

test('JPEG metadata extraction, injection, and stripping preserve exact EXIF, XMP, ICC, and Title', () => {
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

  const commentSeg = createJpegSegment(0xfe, new TextEncoder().encode('Shot on CineStill 800T'));

  const uploadJpeg = injectImageMetadataBytes(
    baseJpeg,
    {
      jpegSegments: [app1Exif, app1Xmp, commentSeg],
    },
    'image/jpeg'
  );

  // Extract from uploaded JPEG
  const extracted = extractImageMetadata(uploadJpeg, 'image/jpeg', 'Tokyo_Rain_01.JPG');
  assert.equal(extracted.format, 'image/jpeg');
  assert.equal(extracted.hasMetadata, true);
  assert.equal(extracted.title, 'Tokyo Rain Halation');
  assert.ok(extracted.tagsSummary.includes('EXIF'));
  assert.ok(extracted.tagsSummary.includes('XMP'));
  assert.ok(extracted.tagsSummary.includes('Comment'));
  assert.equal(extracted.jpegSegments.length, 3);

  // Inject into a freshly canvas-encoded (clean) JPEG
  const canvasRenderedJpeg = createMinimalJpegBytes();
  const exportedJpeg = injectImageMetadataBytes(canvasRenderedJpeg, extracted, 'image/jpeg');

  const reExtracted = extractImageMetadata(exportedJpeg, 'image/jpeg', 'Tokyo_Rain_01.JPG');
  assert.equal(reExtracted.hasMetadata, true);
  assert.equal(reExtracted.title, 'Tokyo Rain Halation');
  assert.equal(reExtracted.jpegSegments.length, 3);
  assert.deepEqual(reExtracted.rawExifTiff, exifTiff);
  assert.equal(parseExifTitle(reExtracted.rawExifTiff), 'Tokyo Rain Halation');

  // Strip metadata when toggle is ON
  const strippedJpeg = stripImageMetadataBytes(exportedJpeg, 'image/jpeg');
  const afterStrip = extractImageMetadata(strippedJpeg, 'image/jpeg', 'Tokyo_Rain_01.JPG');
  assert.equal(afterStrip.hasMetadata, false);
  assert.equal(afterStrip.jpegSegments.length, 0);
  assert.equal(afterStrip.rawExifTiff, null);
  assert.equal(afterStrip.rawXmp, null);
});

test('PNG metadata extraction, injection, and stripping preserve exact eXIf, tEXt, and iTXt chunks', () => {
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

  // Inject rich metadata into the sample PNG to simulate an uploaded PNG with metadata
  const richPng = injectImageMetadataBytes(
    rawPng,
    {
      pngChunks: [
        { type: 'eXIf', data: exifTiff, rawChunk: exifChunk },
        { type: 'tEXt', data: new Uint8Array(0), rawChunk: titleChunk },
        { type: 'tEXt', data: new Uint8Array(0), rawChunk: authorChunk },
        { type: 'iTXt', data: new Uint8Array(0), rawChunk: xmpChunk },
      ],
    },
    'image/png'
  );

  const extracted = extractImageMetadata(richPng, 'image/png', 'Night_Kiosk_35mm.png');
  assert.equal(extracted.format, 'image/png');
  assert.equal(extracted.hasMetadata, true);
  assert.equal(extracted.title, 'Night Kiosk 35mm');
  assert.ok(extracted.tagsSummary.includes('EXIF'));
  assert.ok(extracted.tagsSummary.includes('XMP'));
  assert.ok(extracted.tagsSummary.includes('Title'));
  assert.ok(extracted.tagsSummary.includes('Text'));

  // Inject into clean PNG
  const cleanBasePng = stripImageMetadataBytes(rawPng, 'image/png');
  const exportedPng = injectImageMetadataBytes(cleanBasePng, extracted, 'image/png');
  const verifyExport = extractImageMetadata(exportedPng, 'image/png', 'Night_Kiosk_35mm.png');

  assert.equal(verifyExport.hasMetadata, true);
  assert.equal(verifyExport.title, 'Night Kiosk 35mm');
  assert.deepEqual(verifyExport.rawExifTiff, exifTiff);
  assert.equal(verifyExport.pngChunks.length, extracted.pngChunks.length);

  // Strip metadata when toggle is enabled
  const strippedPng = stripImageMetadataBytes(exportedPng, 'image/png');
  const verifyStripped = extractImageMetadata(strippedPng, 'image/png', 'Night_Kiosk_35mm.png');
  assert.equal(verifyStripped.hasMetadata, false);
  assert.equal(verifyStripped.pngChunks.length, 0);
  assert.equal(verifyStripped.rawExifTiff, null);
});

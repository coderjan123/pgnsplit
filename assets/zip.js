/*
 * Minimal ZIP writer, no dependencies.
 *
 * Entries are deflated with the browser's own CompressionStream
 * ("deflate-raw"), and stored uncompressed when that is not available or when
 * deflating would make the entry bigger.  That is all a ZIP needs, and it keeps
 * the download of a few hundred megabytes of PGN small.
 */
(function (global) {
  "use strict";

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function canDeflate() {
    return typeof global.CompressionStream === "function";
  }

  async function deflateRaw(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new global.CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* MS-DOS date and time, as ZIP wants them */
  function dosDateTime(date) {
    var year = Math.max(1980, date.getFullYear());
    return {
      time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31),
      date: (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31)
    };
  }

  function utf8Name(name) {
    return new TextEncoder().encode(name);
  }

  /*
   * create([{name, data: Uint8Array}, ...]) -> Blob
   * data may be a string, which is encoded as UTF-8.
   */
  async function create(entries, when) {
    var stamp = dosDateTime(when || new Date());
    var locals = [];
    var centrals = [];
    var offset = 0;
    var totalIn = 0;
    var totalOut = 0;

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var data = typeof entry.data === "string" ? new TextEncoder().encode(entry.data) : entry.data;
      var nameBytes = utf8Name(entry.name);
      totalIn += data.length;

      var payload = data;
      var method = 0;
      if (canDeflate() && data.length > 64) {
        var packed = await deflateRaw(data);
        if (packed.length < data.length) {
          payload = packed;
          method = 8;
        }
      }
      totalOut += payload.length;

      var crc = crc32(data);
      var local = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);     /* local file header signature */
      lv.setUint16(4, 20, true);             /* version needed */
      lv.setUint16(6, 0x0800, true);         /* flags: UTF-8 names */
      lv.setUint16(8, method, true);
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, payload.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);             /* extra field length */
      local.set(nameBytes, 30);
      locals.push(local, payload);

      var central = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);     /* central directory header */
      cv.setUint16(4, 20, true);             /* version made by */
      cv.setUint16(6, 20, true);             /* version needed */
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, payload.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);             /* extra */
      cv.setUint16(32, 0, true);             /* comment */
      cv.setUint16(34, 0, true);             /* disk number */
      cv.setUint16(36, 0, true);             /* internal attributes */
      cv.setUint32(38, 0, true);             /* external attributes */
      cv.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centrals.push(central);

      offset += local.length + payload.length;
    }

    var centralSize = centrals.reduce(function (sum, c) { return sum + c.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    var parts = locals.concat(centrals, [end]);
    var blob = new Blob(parts, { type: "application/zip" });
    return { blob: blob, rawSize: totalIn, zipSize: totalOut };
  }

  /* sha256 of a whole buffer, hex, or null when crypto.subtle is unavailable */
  async function sha256Hex(bytes) {
    if (!global.crypto || !global.crypto.subtle) return null;
    var digest = await global.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map(function (b) { return b.toString(16).padStart(2, "0"); })
      .join("");
  }

  global.PgnZip = { create: create, crc32: crc32, sha256Hex: sha256Hex, canDeflate: canDeflate };
})(typeof window !== "undefined" ? window : globalThis);
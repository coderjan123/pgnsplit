/*
 * pgnsplit core - the browser twin of pgnsplit.py
 *
 * Splits a PGN into byte ranges, one per game, without ever re-serializing the
 * data: every output file is a concatenation of slices of the input, so
 * comments, variations, NAGs, [%cal]/[%csl]/[%evp] annotations, the UTF-8 BOM
 * and the original line endings survive untouched.  Header tags are never
 * modified.
 *
 * Classic script (no ES module) on purpose, so that index.html also works when
 * it is opened straight from disk with file://.
 */
(function (global) {
  "use strict";

  var TAB = 0x09, LF = 0x0a, VT = 0x0b, FF = 0x0c, CR = 0x0d;
  var SPACE = 0x20;
  var QUOTE = 0x22, HASH = 0x23, PERCENT = 0x25;
  var LPAREN = 0x28, RPAREN = 0x29, STAR = 0x2a, MINUS = 0x2d, DOT = 0x2e, SLASH = 0x2f;
  var D0 = 0x30, D9 = 0x39;
  var LBRACKET = 0x5b, BSLASH = 0x5c, RBRACKET = 0x5d, UNDERSCORE = 0x5f;
  var LBRACE = 0x7b, RBRACE = 0x7d;
  var EVENT_TAG = "[Event";

  function isSpace(b) {
    return b === SPACE || b === TAB || b === LF || b === CR || b === VT || b === FF;
  }

  function isNameChar(b) {
    return (b >= D0 && b <= D9) || (b >= 0x41 && b <= 0x5a) ||
           (b >= 0x61 && b <= 0x7a) || b === UNDERSCORE;
  }

  /* the lookaround class of the result pattern: [0-9A-Za-z.-] */
  function isGlued(b) {
    return (b >= D0 && b <= D9) || (b >= 0x41 && b <= 0x5a) ||
           (b >= 0x61 && b <= 0x7a) || b === DOT || b === MINUS;
  }

  /* offset of the first non-whitespace byte in data[a, b), or b */
  function skipSpace(data, a, b) {
    var i = a;
    while (i < b && isSpace(data[i])) i++;
    return i;
  }

  /* first non-whitespace byte in data[a, b), or -1 */
  function firstNonSpace(data, a, b) {
    var i = skipSpace(data, a, b);
    return i < b ? data[i] : -1;
  }

  function startsWithAt(data, a, b, ascii) {
    if (a + ascii.length > b) return false;
    for (var k = 0; k < ascii.length; k++) {
      if (data[a + k] !== ascii.charCodeAt(k)) return false;
    }
    return true;
  }

  /*
   * Find the end of a tag value, i.e. the closing quote.
   * escaped:  the value may contain \" and \\          [White "a \"b"]
   * plain:    a backslash is an ordinary character    [Event "It \"]  <- real
   * Both shapes exist in the wild, so both are accepted; the first one that
   * leads to a well formed tag pair wins.
   * Returns the offset of the closing quote, or -1.
   */
  function endOfValue(data, i, b, escaped) {
    while (i < b) {
      var c = data[i];
      if (escaped && c === BSLASH) {
        if (i + 1 >= b) return -1;
        i += 2;
        continue;
      }
      if (c === QUOTE) return i;
      if (c === CR || c === LF) return -1;
      i++;
    }
    return -1;
  }

  /*
   * Is data[a, b) a tag pair line?  Mirrors is_tag() in pgnsplit.py.
   * Returns the offset just past the tag name, or -1, and puts the tag name
   * into `tag` when given.
   */
  function matchTagLine(data, a, b, tag) {
    var i = a;
    if (i + 2 < b && data[i] === 0xef && data[i + 1] === 0xbb && data[i + 2] === 0xbf) i += 3;
    while (i < b && (data[i] === SPACE || data[i] === TAB)) i++;
    if (i >= b || data[i] !== LBRACKET) return -1;
    i++;
    while (i < b && (data[i] === SPACE || data[i] === TAB)) i++;
    if (i >= b || !isNameChar(data[i])) return -1;
    var nameStart = i;
    while (i < b && isNameChar(data[i])) i++;
    var nameEnd = i;
    while (i < b && (data[i] === SPACE || data[i] === TAB)) i++;
    if (i >= b || data[i] !== QUOTE) return -1;
    i++;

    var quote = endOfValue(data, i, b, true);
    if (quote < 0 || !tagEnds(data, quote + 1, b)) quote = endOfValue(data, i, b, false);
    if (quote < 0) return -1;
    if (!tagEnds(data, quote + 1, b)) return -1;

    if (tag) tag.name = latin1(data, nameStart, nameEnd);
    return nameEnd;
  }

  /* after the closing quote: [ \t]* ] [ \t]* and the line terminator */
  function tagEnds(data, i, b) {
    while (i < b && (data[i] === SPACE || data[i] === TAB)) i++;
    if (i >= b || data[i] !== RBRACKET) return false;
    i++;
    while (i < b && (data[i] === SPACE || data[i] === TAB)) i++;
    if (i < b && data[i] === CR) i++;
    if (i < b && data[i] === LF) i++;
    return i === b;
  }

  /* small ASCII slice, only used for tag names */
  function latin1(data, a, b) {
    var s = "";
    for (var i = a; i < b; i++) s += String.fromCharCode(data[i]);
    return s;
  }

  /*
   * First result token (1-0, 0-1, 1/2-1/2, *) inside data[a, b) that is not
   * glued to an alphanumeric character, '.' or '-'.  Returns the offset just
   * past the token, or -1.  The bytes before a and after the token are looked
   * at, exactly like the lookarounds of the regular expression in pgnsplit.py.
   */
  function findResult(data, a, b) {
    for (var i = a; i < b; i++) {
      var c = data[i];
      if (c !== D0 && c !== D0 + 1 && c !== STAR) continue;
      if (i > 0 && isGlued(data[i - 1])) continue;
      var len = 0;
      if (c === STAR) {
        len = 1;
      } else if (c === D0 + 1 && i + 2 < b && data[i + 1] === MINUS && data[i + 2] === D0) {
        len = 3; /* 1-0 */
      } else if (c === D0 && i + 2 < b && data[i + 1] === MINUS && data[i + 2] === D0 + 1) {
        len = 3; /* 0-1 */
      } else if (c === D0 + 1 && i + 6 < b &&
                 data[i + 1] === SLASH && data[i + 2] === D0 + 2 && data[i + 3] === MINUS &&
                 data[i + 4] === D0 + 1 && data[i + 5] === SLASH && data[i + 6] === D0 + 2) {
        len = 7; /* 1/2-1/2 */
      }
      if (!len) continue;
      var next = i + len;
      if (next < data.length && isGlued(data[next])) continue;
      return next;
    }
    return -1;
  }

  /*
   * Walk one line, tracking {} comment and () variation nesting.
   * Returns [depth at the end of the line, offset just past a depth-0 result
   * token or -1].  A result inside a comment must not end a game (Chessable
   * exports are full of them, e.g. `{ ... -josecuenca 0-1 chess24.com 2015 }`),
   * which is why the search runs per depth-0 segment instead of over the line.
   */
  function scanLine(data, a, b, depth) {
    var segStart = a, segDepth = depth, found = -1, limit = b;
    for (var i = a; i < limit; i++) {
      var c = data[i];
      if (c === 0x3b && depth === 0) { limit = i; break; } /* ';' comment */
      if (c === LBRACE || c === LPAREN) {
        if (segDepth === 0) {
          found = findResult(data, segStart, i);
          if (found >= 0) return [depth, found];
        }
        depth++;
        segStart = i + 1;
        segDepth = depth;
      } else if (c === RBRACE || c === RPAREN) {
        if (segDepth === 0) {
          found = findResult(data, segStart, i);
          if (found >= 0) return [depth, found];
        }
        depth = depth > 0 ? depth - 1 : 0;
        segStart = i + 1;
        segDepth = depth;
      }
    }
    if (segDepth === 0) {
      found = findResult(data, segStart, limit);
      if (found >= 0) return [depth, found];
    }
    return [depth, -1];
  }

  /* first offset after the run of blank lines starting at pos */
  function skipBlank(data, pos) {
    var n = data.length;
    for (;;) {
      var i = pos;
      while (i < n && data[i] !== LF && data[i] !== CR) {
        if (!isSpace(data[i])) return pos;
        i++;
      }
      if (i >= n) return n;                       /* whitespace only, no terminator */
      if (data[i] === CR && data[i + 1] === LF) pos = i + 2;
      else pos = i + 1;
    }
  }

  function newGame(start) {
    return {
      start: start, end: start, depth: 0,
      hasTagLine: false, hasResultTag: false, hasMovetext: false
    };
  }

  /*
   * Generator so the UI can stay responsive on huge files: yields the byte
   * position every ~64k lines and finally returns { games, notes, lines }.
   */
  function* splitCore(data) {
    var n = data.length;
    var games = [];
    var notes = [];
    var tag = { name: "" };
    var current = newGame(0);
    var start = 0, depth = 0, inMovetext = false, inTags = false, blankRun = 0;
    var pos = 0, lines = 0, n = data.length;

    function close(end) {
      current.depth = depth;
      current.end = end;
      games.push(current);
      current = newGame(end);
      inMovetext = false;
      inTags = false;
    }

    while (pos < n) {
      /* CR, LF and CRLF all end a line: some exports still use classic mac endings */
      var nl = pos;
      while (nl < n && data[nl] !== LF && data[nl] !== CR) nl++;
      var lineStart = pos;
      var lineEnd;
      if (nl >= n) lineEnd = n;
      else if (data[nl] === CR && nl + 1 < n && data[nl + 1] === LF) lineEnd = nl + 2;
      else lineEnd = nl + 1;
      pos = lineEnd;
      lines++;

      var first = firstNonSpace(data, lineStart, lineEnd);
      var blank = first < 0;

      if (depth === 0) {
        tag.name = "";
        if (matchTagLine(data, lineStart, lineEnd, tag) >= 0) {
          /* a tag block followed by two blank lines and then more tags is a
             game of its own, even without a single move */
          if (inMovetext || (inTags && blankRun >= 2)) close(lineStart);
          inTags = true;
          blankRun = 0;
          current.hasTagLine = true;
          if (tag.name === "Result") current.hasResultTag = true;
          if ((lines & 0xffff) === 0) yield pos;
          continue;
        }
      }

      if (depth > 0 && first === LBRACKET &&
          startsWithAt(data, skipSpace(data, lineStart, lineEnd), lineEnd, EVENT_TAG)) {
        notes.push({ kind: "resync", line: lines, text: "unclosed comment or variation before a new game, resynchronised" });
        close(lineStart);
        depth = 0;
        /* the [Event line opens the new game, but only count it as a tag pair
           when it really is one: a line carrying several tag pairs at once is
           not one, and python merges such a block into the previous game */
        if (matchTagLine(data, lineStart, lineEnd, null) >= 0) current.hasTagLine = true;
        if ((lines & 0xffff) === 0) yield pos;
        continue;
      }

      if (depth === 0) {
        if (first === PERCENT) {           /* % escape line */
          if ((lines & 0xffff) === 0) yield pos;
          continue;
        }
        if (blank) {
          blankRun++;
        } else {
          blankRun = 0;
          inMovetext = true;
          inTags = false;
          current.hasMovetext = true;
        }
      }

      var scan = scanLine(data, lineStart, lineEnd, depth);
      depth = scan[0];
      if (scan[1] >= 0 && inMovetext) close(lineEnd);
      if ((lines & 0xffff) === 0) yield pos;
    }

    current.depth = depth;
    if (current.start < n) {
      if (skipSpace(data, current.start, n) === n && games.length > 0) {
        games[games.length - 1].end = n;   /* trailing blank lines are not a game */
      } else {
        current.end = n;
        games.push(current);
      }
    }

    /* the blank lines between two games belong to the first one */
    for (var i = 0; i < games.length - 1; i++) {
      var e = skipBlank(data, games[i].end);
      games[i].end = e;
      games[i + 1].start = e;
    }

    /* a block without any tag pair is the continuation of the previous game */
    var merged = [];
    for (var k = 0; k < games.length; k++) {
      var g = games[k];
      if (merged.length > 0 && !g.hasTagLine) {
        notes.push({ kind: "merge", game: merged.length,
                     text: "continuation block without headers merged into game " + merged.length });
        var last = merged[merged.length - 1];
        last.end = g.end;
        last.hasMovetext = last.hasMovetext || g.hasMovetext;
        last.depth = g.depth;
      } else {
        merged.push(g);
      }
    }

    return { games: merged, notes: notes, lines: lines };
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(function () { resolve(); });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  /*
   * plan(bytes, gamesPerFile, onProgress) -> everything the UI needs.
   * One pass over the data; chunks are groups of games.
   */
  async function plan(bytes, gamesPerFile, onProgress) {
    var started = Date.now();
    var it = splitCore(bytes);
    var step = it.next();
    while (!step.done) {
      if (onProgress) onProgress({ phase: "scan", fraction: bytes.length ? step.value / bytes.length : 1 });
      await nextFrame();
      step = it.next();
    }
    var out = step.value;
    var games = out.games;

    if (onProgress) onProgress({ phase: "scan", fraction: 1 });

    var problems = [];
    var hasTags = false;
    for (var i = 0; i < games.length; i++) {
      var g = games[i];
      if (g.hasTagLine) hasTags = true;
      var where = "game " + (i + 1);
      if (g.end === g.start) { problems.push({ game: i + 1, text: where + ": empty" }); continue; }
      if (!g.hasResultTag) problems.push({ game: i + 1, text: where + ": no [Result] tag" });
      if (!g.hasMovetext) problems.push({ game: i + 1, text: where + ": header block only, no moves" });
      if (g.depth !== 0) {
        problems.push({ game: i + 1,
                        text: where + ": " + g.depth + " unclosed comment/variation bracket(s)" });
      }
    }

    var chunks = [];
    for (var j = 0; j < games.length; j += gamesPerFile) {
      chunks.push(games.slice(j, Math.min(j + gamesPerFile, games.length)));
    }

    return {
      bytes: bytes,
      games: games,
      chunks: chunks,
      notes: out.notes,
      problems: problems,
      lines: out.lines,
      hasTags: hasTags,
      scanMs: Date.now() - started
    };
  }

  /* file stem, like pathlib's Path.stem */
  function stemOf(name) {
    var base = String(name).split(/[\\/]/).pop();
    var dot = base.lastIndexOf(".");
    if (dot > 0) base = base.slice(0, dot);
    return base || "games";
  }

  /* output names for one input: Foo_001.pgn, Foo_002.pgn, ... */
  function outputNames(inputName, chunkCount) {
    var stem = stemOf(inputName);
    var width = Math.max(3, String(chunkCount).length);
    var names = [];
    for (var i = 1; i <= chunkCount; i++) {
      var num = String(i);
      while (num.length < width) num = "0" + num;
      names.push(stem + "_" + num + ".pgn");
    }
    return names;
  }

  function humanSize(n) {
    if (n < 1024) return n + " B";
    var units = ["KB", "MB", "GB"], v = n / 1024, u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return (u === 0 ? Math.round(v) : v.toFixed(1)) + " " + units[u];
  }

  global.PgnSplit = {
    plan: plan,
    splitCore: splitCore,
    /* synchronous drain, for tests and tools; the UI uses plan() */
    scanCore: function (bytes) {
      var it = splitCore(bytes);
      var step = it.next();
      while (!step.done) step = it.next();
      return step.value;
    },
    outputNames: outputNames,
    stemOf: stemOf,
    humanSize: humanSize,
    matchTagLine: matchTagLine,
    scanLine: scanLine,
    findResult: findResult
  };
})(typeof window !== "undefined" ? window : globalThis);
/*
 * pgnsplit web UI.
 *
 * Reads the chosen files into memory, asks assets/split.js for the byte ranges,
 * shows what would happen, and hands the result over as a ZIP (or writes it
 * straight into a folder when the browser supports it).  Nothing is uploaded:
 * there is not a single network request in this app.
 */
(function () {
  "use strict";

  var S = window.PgnSplit;
  var Z = window.PgnZip;

  var el = {
    drop: document.getElementById("drop"),
    input: document.getElementById("file-input"),
    pick: document.getElementById("pick"),
    games: document.getElementById("games"),
    downloadAll: document.getElementById("download-all"),
    clear: document.getElementById("clear"),
    useFolder: document.getElementById("use-folder"),
    progress: document.getElementById("progress"),
    progressFill: document.getElementById("progress-fill"),
    progressText: document.getElementById("progress-text"),
    report: document.getElementById("report")
  };

  /** every file the user picked: {id, name, size, bytes, state, ...} */
  var jobs = [];
  var nextId = 1;
  var busy = false;
  var dirHandle = null;

  var MAX_TABLE_ROWS = 400;
  var MAX_LISTED = 12;
  /* above this the sha256 round-trip would need a second copy of the file */
  var MAX_SHA_BYTES = 256 * 1024 * 1024;

  /* ----------------------------------------------------------------- helpers */

  function text(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }

  function bytesOf(plan) {
    return plan.bytes;
  }

  function chunkBytes(job, chunk) {
    return bytesOf(job).subarray(chunk[0].start, chunk[chunk.length - 1].end);
  }

  function chunkSize(job, chunk) {
    return chunk[chunk.length - 1].end - chunk[0].start;
  }

  function buildChunks(games, perFile) {
    var chunks = [];
    for (var i = 0; i < games.length; i += perFile) {
      chunks.push(games.slice(i, Math.min(i + perFile, games.length)));
    }
    return chunks;
  }

  function perFile() {
    var n = parseInt(el.games.value, 10);
    if (!isFinite(n) || n < 1) n = 64;
    if (n > 100000) n = 100000;
    return n;
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function setProgress(fraction, label) {
    if (fraction === null) {
      el.progress.hidden = true;
      return;
    }
    el.progress.hidden = false;
    el.progressFill.style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + "%";
    el.progressText.textContent = label || "";
  }

  function updateButtons() {
    var ready = jobs.filter(function (j) { return j.state === "ready"; });
    var totalChunks = ready.reduce(function (sum, j) { return sum + j.names.length; }, 0);
    el.downloadAll.disabled = busy || totalChunks === 0;
    el.downloadAll.textContent = totalChunks > 0
      ? "Download all as ZIP (" + totalChunks + " files)"
      : "Download all as ZIP";
    el.clear.disabled = busy || jobs.length === 0;
    el.games.disabled = busy;
  }

  /* --------------------------------------------------------- output naming */

  /*
   * Two inputs with the same stem would produce the same output names, so the
   * second one gets the name of its folder in front.  Names are handed out from
   * one shared pool, so nothing can ever collide inside a ZIP or a folder.
   */
  var usedNames = new Set();

  function assignNames(job) {
    var wanted = S.outputNames(job.name, job.chunks.length);
    var parent = job.name.split(/[\\/]/).slice(-2, -1)[0] || "";
    var safeParent = parent.replace(/[\\/:*?"<>|]/g, "_");
    var renamed = false;
    job.names = wanted.map(function (name) {
      if (!usedNames.has(name)) return name;
      renamed = true;
      var candidate = safeParent ? safeParent + "__" + name
                                 : name.replace(/\.pgn$/i, "") + "__copy.pgn";
      var n = 2;
      while (usedNames.has(candidate)) {
        candidate = (safeParent || S.stemOf(job.name)) + "__" + n + "__" + name;
        n++;
      }
      return candidate;
    });
    job.names.forEach(function (n) { usedNames.add(n); });
    job.renamed = renamed;
  }

  function rebuildNames() {
    usedNames = new Set();
    jobs.forEach(function (job) {
      if (job.state === "ready") assignNames(job);
    });
  }

  /* -------------------------------------------------------------- rendering */

  function render() {
    el.report.textContent = "";
    jobs.forEach(function (job) {
      el.report.appendChild(renderJob(job));
    });
    updateButtons();
  }

  function renderJob(job) {
    var card = text("section", "file");

    var head = text("header");
    head.appendChild(text("span", "name", job.name));
    head.appendChild(text("span", "meta", job.meta || ""));
    head.appendChild(text("span", "spacer"));
    if (job.state === "ready") {
      var dl = text("button", null, el.useFolder.checked ? "Write files" : "Download ZIP");
      dl.addEventListener("click", function () { saveOne(job); });
      head.appendChild(dl);
    }
    var remove = text("button", null, "Remove");
    remove.addEventListener("click", function () {
      jobs = jobs.filter(function (j) { return j !== job; });
      render();
    });
    head.appendChild(remove);
    card.appendChild(head);

    var body = text("div", "body");

    if (job.state === "reading") {
      body.appendChild(text("p", "dim", "reading..."));
    } else if (job.state === "error") {
      var err = text("div", "box err");
      err.appendChild(text("h3", null, "cannot split"));
      err.appendChild(text("div", null, job.error));
      body.appendChild(err);
    } else if (job.state === "ready") {
      body.appendChild(summaryOf(job));
      body.appendChild(problemBox(job));
      body.appendChild(notesBox(job));
      body.appendChild(tableOf(job));
    }
    card.appendChild(body);
    return card;
  }

  function summaryOf(job) {
    var box = text("div", "box ok");
    var games = job.games.length;
    var files = job.chunks.length;
    var last = job.chunks.length ? job.chunks[job.chunks.length - 1].length : 0;
    var first = job.chunks.length ? job.chunks[0].length : 0;
    box.appendChild(text("h3", null,
      games + (games === 1 ? " game" : " games") + " → " + files + (files === 1 ? " file" : " files") +
      " of " + first + (last === first ? "" : " (last one " + last + ")")));
    if (job.sha === "length-only") {
      box.appendChild(text("div", null,
        "chunk lengths add up to the file (" + S.humanSize(job.size) +
        "); too large to hash a second time in memory"));
    } else if (job.sha) {
      box.appendChild(text("div", null,
        "sha256 of the chunks matches the input: " + job.sha.slice(0, 16) + "…"));
    }
    if (job.renamed) {
      box.appendChild(text("div", null, "output names were made unique across all loaded files"));
    }
    if (job.saved) {
      box.appendChild(text("div", null, job.saved));
    }
    return box;
  }

  function problemBox(job) {
    if (!job.problems.length) return text("div");
    var box = text("div", "box warn");
    box.appendChild(text("h3", null,
      job.problems.length + " note about the source file (the games are copied anyway)"));
    var list = text("ul");
    job.problems.slice(0, MAX_LISTED).forEach(function (p) { list.appendChild(text("li", null, p.text)); });
    box.appendChild(list);
    if (job.problems.length > MAX_LISTED) {
      box.appendChild(text("div", "more", "… and " + (job.problems.length - MAX_LISTED) + " more"));
    }
    return box;
  }

  function notesBox(job) {
    if (!job.notes.length) return text("div");
    var box = text("div", "box warn");
    box.appendChild(text("h3", null, job.notes.length + " repair(s) while splitting"));
    var list = text("ul");
    job.notes.slice(0, MAX_LISTED).forEach(function (n) {
      list.appendChild(text("li", null, (n.line ? "line " + n.line + ": " : "") + n.text));
    });
    box.appendChild(list);
    if (job.notes.length > MAX_LISTED) {
      box.appendChild(text("div", "more", "… and " + (job.notes.length - MAX_LISTED) + " more"));
    }
    return box;
  }

  function tableOf(job) {
    var details = document.createElement("details");
    details.appendChild(text("summary", null, "the " + job.names.length + " output file(s)"));
    var table = text("table");
    var thead = text("thead");
    var hr = text("tr");
    ["#", "file", "games", "size"].forEach(function (h) { hr.appendChild(text("th", null, h)); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = text("tbody");
    var shown = Math.min(job.chunks.length, MAX_TABLE_ROWS);
    for (var i = 0; i < shown; i++) {
      var chunk = job.chunks[i];
      var tr = text("tr");
      tr.appendChild(text("td", "num", i + 1));
      tr.appendChild(text("td", "name", job.names[i]));
      tr.appendChild(text("td", "num", chunk.length));
      tr.appendChild(text("td", "num", S.humanSize(chunkSize(job, chunk))));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    details.appendChild(table);
    if (job.chunks.length > shown) {
      details.appendChild(text("div", "small dim",
        "showing the first " + shown + " of " + job.chunks.length + " files"));
    }
    return details;
  }

  /* -------------------------------------------------------------- pipeline */

  function looksUtf16(bytes) {
    /* a UTF-16 file cannot be split byte by byte, anything else can */
    var why = S.encodingProblem(bytes);
    if (!why) return null;
    return why + ". Convert it first, for example:\n" +
      "iconv -f UTF-16 -t UTF-8 file.pgn > utf8.pgn";
  }

  async function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    busy = true;
    updateButtons();
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var job = { id: nextId++, name: file.name, size: file.size, state: "reading" };
      jobs.push(job);
      render();
      setProgress(0, "reading " + file.name);
      try {
        var buffer = await file.arrayBuffer();
        var bytes = new Uint8Array(buffer);
        if (bytes.length === 0) throw new Error("the file is empty");
        var encoding = looksUtf16(bytes);
        if (encoding) throw new Error(encoding);
        job.bytes = bytes;
        job.size = bytes.length;
        setProgress(0, "splitting " + file.name);
        var result = await S.plan(bytes, perFile(), function (p) {
          setProgress(p.fraction * 0.9, "splitting " + file.name);
        });
        if (!result.hasTags) {
          throw new Error("no [Tag \"...\"] headers found, so this is not a PGN file");
        }
        job.games = result.games;
        job.notes = result.notes;
        job.problems = result.problems;
        job.chunks = buildChunks(result.games, perFile());
        job.state = "ready";
        rebuildNames();
        job.meta = result.games.length + " games, " + S.humanSize(bytes.length) +
                   ", scanned in " + (result.scanMs < 1000 ? result.scanMs + " ms" : (result.scanMs / 1000).toFixed(1) + " s");
        job.sha = await verify(job);
      } catch (err) {
        job.state = "error";
        job.error = err && err.message ? err.message : String(err);
      }
      setProgress(null);
      render();
    }
    busy = false;
    updateButtons();
  }

  /*
   * Rebuild the chunks in memory and compare the sha256 of both sides.  For a
   * very large file the second copy is skipped and only the lengths are
   * compared, so the tab does not run out of memory.
   */
  async function verify(job) {
    try {
      var hash = Z.sha256Hex;
      if (!hash) return null;
      var total = 0;
      for (var i = 0; i < job.chunks.length; i++) total += chunkSize(job, job.chunks[i]);
      if (total !== job.bytes.length) {
        job.problems.push({ text: "internal check failed: the chunks do not add up to the input" });
        return null;
      }
      if (total > MAX_SHA_BYTES) {
        return "length-only";
      }
      var inputHash = await hash(job.bytes);
      var joined = new Uint8Array(total);
      var at = 0;
      for (var j = 0; j < job.chunks.length; j++) {
        var slice = chunkBytes(job, job.chunks[j]);
        joined.set(slice, at);
        at += slice.length;
      }
      var chunksHash = await hash(joined);
      if (chunksHash !== inputHash) {
        job.problems.push({ text: "internal check failed: the chunks do not add up to the input" });
        return null;
      }
      return chunksHash;
    } catch (err) {
      return null;
    }
  }

  function replan() {
    var n = perFile();
    jobs.forEach(function (job) {
      if (job.state !== "ready") return;
      job.chunks = buildChunks(job.games, n);
    });
    rebuildNames();
    render();
  }

  /* ---------------------------------------------------------------- saving */

  async function ensureFolder() {
    if (el.useFolder.checked && typeof window.showDirectoryPicker === "function") {
      if (!dirHandle) {
        dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      }
      return dirHandle;
    }
    return null;
  }

  async function saveOne(job) {
    try {
      var folder = await ensureFolder();
      if (folder) {
        var written = 0, skipped = 0;
        for (var i = 0; i < job.chunks.length; i++) {
          var name = job.names[i];
          var exists = true;
          try { await folder.getFileHandle(name, { create: false }); } catch (e) { exists = false; }
          if (exists) { skipped++; continue; }        /* never overwrite */
          var handle = await folder.getFileHandle(name, { create: true });
          var writable = await handle.createWritable();
          await writable.write(chunkBytes(job, job.chunks[i]));
          await writable.close();
          written++;
        }
        var msg = "wrote " + written + " file(s) into the folder";
        if (skipped) msg += ", " + skipped + " already existed and were left alone";
        job.saved = msg;
        render();
      } else if (job.chunks.length === 1) {
        /* a single chunk is handed over as the plain pgn, not wrapped in a zip */
        var only = chunkBytes(job, job.chunks[0]);
        downloadBlob(new Blob([only], { type: "application/x-chess-pgn" }), job.names[0]);
        job.saved = "saved " + job.names[0] + " (" + S.humanSize(only.length) + ")";
        render();
      } else {
        var entries = job.chunks.map(function (chunk, i) {
          return { name: job.names[i], data: chunkBytes(job, chunk) };
        });
        var zip = await Z.create(entries);
        downloadBlob(zip.blob, S.stemOf(job.name) + "_chunks.zip");
        job.saved = "saved a zip of " + entries.length + " files, " + S.humanSize(zip.zipSize) +
                    " (uncompressed " + S.humanSize(zip.rawSize) + ")";
        render();
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
      alert("Could not save: " + (err && err.message ? err.message : err));
    }
  }

  async function saveAll() {
    var ready = jobs.filter(function (j) { return j.state === "ready"; });
    if (!ready.length) return;
    try {
      var folder = await ensureFolder();
      var entries = [];
      var written = 0, skipped = 0;
      for (var i = 0; i < ready.length; i++) {
        var job = ready[i];
        for (var j = 0; j < job.chunks.length; j++) {
          var name = job.names[j];
          var slice = chunkBytes(job, job.chunks[j]);
          if (folder) {
            var exists = true;
            try { await folder.getFileHandle(name, { create: false }); } catch (e) { exists = false; }
            if (exists) { skipped++; continue; }
            var handle = await folder.getFileHandle(name, { create: true });
            var writable = await handle.createWritable();
            await writable.write(slice);
            await writable.close();
            written++;
          } else {
            entries.push({ name: name, data: slice });
          }
        }
        setProgress(i / ready.length, "packing " + job.name);
      }
      if (folder) {
        var msg = "wrote " + written + " file(s) into the folder";
        if (skipped) msg += ", " + skipped + " already existed and were left alone";
        alert(msg);
      } else {
        var zip = await Z.create(entries);
        downloadBlob(zip.blob, "pgnsplit-chunks.zip");
        alert(entries.length + " files, " + S.humanSize(zip.zipSize) + " zipped " +
              "(was " + S.humanSize(zip.rawSize) + ")");
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
      alert("Could not save: " + (err && err.message ? err.message : err));
    } finally {
      setProgress(null);
    }
  }

  /* ----------------------------------------------------------------- events */

  el.pick.addEventListener("click", function () { el.input.click(); });
  el.drop.addEventListener("click", function (e) {
    if (e.target === el.pick || el.pick.contains(e.target)) return;
    el.input.click();
  });
  el.drop.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.input.click(); }
  });
  el.input.addEventListener("change", function () {
    addFiles(el.input.files);
    el.input.value = "";
  });

  ["dragenter", "dragover"].forEach(function (name) {
    el.drop.addEventListener(name, function (e) {
      e.preventDefault();
      el.drop.classList.add("over");
    });
  });
  ["dragleave", "drop"].forEach(function (name) {
    el.drop.addEventListener(name, function (e) {
      e.preventDefault();
      if (name === "dragleave" && el.drop.contains(e.relatedTarget)) return;
      el.drop.classList.remove("over");
    });
  });
  el.drop.addEventListener("drop", function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      addFiles(e.dataTransfer.files);
    }
  });
  /* do not let a stray drop navigate the page away */
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("drop", function (e) { e.preventDefault(); });

  var gamesTimer = null;
  el.games.addEventListener("input", function () {
    clearTimeout(gamesTimer);
    gamesTimer = setTimeout(replan, 250);
  });
  el.useFolder.addEventListener("change", function () {
    if (el.useFolder.checked && typeof window.showDirectoryPicker !== "function") {
      el.useFolder.checked = false;
      alert("This browser cannot write into a folder. Use the ZIP download instead " +
            "(File System Access API is Chromium only).");
    }
    render();
  });
  el.clear.addEventListener("click", function () {
    jobs = [];
    render();
  });
  el.downloadAll.addEventListener("click", saveAll);

  /*
   * A tiny scripting hook, handy in the console and used by the tests:
   *   await pgnsplit.addBytes("lecture.pgn", someUint8Array)
   *   pgnsplit.state()
   */
  window.pgnsplit = {
    addFiles: addFiles,
    addBytes: async function (name, bytes) {
      var file = new File([bytes], name);
      await addFiles([file]);
      return jobs[jobs.length - 1];
    },
    zipOf: async function (jobIndex) {
      var job = jobs[jobIndex || 0];
      var entries = job.chunks.map(function (chunk, i) {
        return { name: job.names[i], data: chunkBytes(job, chunk) };
      });
      return Z.create(entries);
    },
    state: function () {
      return jobs.map(function (job) {
        return {
          name: job.name, state: job.state, error: job.error, games: job.games ? job.games.length : 0,
          files: job.chunks ? job.chunks.length : 0, names: job.names,
          problems: job.problems, notes: job.notes, sha: job.sha
        };
      });
    }
  };

  render();
})();
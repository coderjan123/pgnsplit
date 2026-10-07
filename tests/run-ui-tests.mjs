/*
 * Drives the real UI in jsdom: loads index.html and the three scripts, feeds a
 * PGN through the file input, and checks what the user would see.
 *
 *   node tests/run-ui-tests.mjs
 *
 * jsdom is not a dependency of this project; point NODE_PATH at an existing
 * installation, e.g.
 *   NODE_PATH=/home/jan/lichess-fen/node_modules node tests/run-ui-tests.mjs
 * If jsdom cannot be found, the test prints a note and exits 0.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let JSDOM;
try {
  JSDOM = createRequire(import.meta.url)("jsdom").JSDOM;
} catch (err) {
  console.log("jsdom not installed, skipping the UI tests");
  console.log("  NODE_PATH=<somewhere>/node_modules node tests/run-ui-tests.mjs");
  process.exit(0);
}

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`); }
}

const html = readFileSync(join(root, "index.html"), "utf8");
const dom = new JSDOM(html, {
  url: "https://example.invalid/pgnsplit/",
  runScripts: "outside-only",
  pretendToBeVisual: true
});
const { window } = dom;

/*
 * jsdom is missing a few globals that every real browser has.  Fill them in
 * from node, so the app runs its normal code paths instead of the fallbacks.
 */
const { webcrypto } = await import("node:crypto");
const { TextEncoder, TextDecoder } = await import("node:util");
/* Blob and TextEncoder are replaced unconditionally: jsdom's Blob has no
   arrayBuffer() in this version, and browsers do have one */
for (const [name, value] of [["crypto", webcrypto], ["TextEncoder", TextEncoder],
                             ["TextDecoder", TextDecoder], ["Blob", globalThis.Blob]]) {
  const missing = name === "crypto" ? !(window.crypto && window.crypto.subtle) : true;
  if (missing) Object.defineProperty(window, name, { value, configurable: true, writable: true });
}

/* the page uses classic scripts, so load them the way a browser would */
for (const file of ["assets/split.js", "assets/zip.js", "assets/app.js"]) {
  window.eval(readFileSync(join(root, file), "utf8"));
}

const doc = window.document;
const text = () => doc.getElementById("report").textContent.replace(/\s+/g, " ").trim();

check("the app exposes its scripting hook", typeof window.pgnsplit === "object");
check("the splitter is loaded", typeof window.PgnSplit === "object");
check("the zip writer is loaded", typeof window.PgnZip === "object");
check("the download button starts disabled", doc.getElementById("download-all").disabled === true);
check("nothing is reported before a file is chosen", doc.querySelectorAll(".file").length === 0);

/* a small PGN with three games, fed through the real file input */
const sample = [
  '[Event "A"]', '[Site "?"]', '[White "One"]', '[Black "Two"]', '[Result "1-0"]', '',
  '1. e4 e5 2. Nf3 {a comment} Nc6 1-0', '',
  '[Event "B"]', '[Site "?"]', '[White "Three"]', '[Black "Four"]', '[Result "0-1"]', '',
  '1. d4 d5 {says 0-1 inside} 2. c4 dxc4 0-1', '',
  '[Event "C"]', '[Site "?"]', '[White "Five"]', '[Black "Six"]', '[Result "*"]', '',
  '1. c4 e5 2. Nc3 (2. Nf3) 2... Nf6 *', ''
].join("\n");

const bytes = new TextEncoder().encode(sample);
const file = new window.File([bytes], "lecture.pgn", { type: "application/x-chess-pgn" });

/* jsdom has no File.arrayBuffer in older versions, so provide one */
if (!file.arrayBuffer) {
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
}

const input = doc.getElementById("file-input");
Object.defineProperty(input, "files", { value: [file], configurable: true });
input.dispatchEvent(new window.Event("change"));

await new Promise((resolve) => setTimeout(resolve, 400));

const state = window.pgnsplit.state();
check("the file was queued", state.length === 1, JSON.stringify(state));
check("it is ready, not an error", state[0] && state[0].state === "ready",
      state[0] && state[0].error);
check("three games were found", state[0] && state[0].games === 3, state[0] && String(state[0].games));
check("one output file is planned", state[0] && state[0].files === 1);
check("it is called lecture_001.pgn", state[0] && state[0].names[0] === "lecture_001.pgn",
      state[0] && state[0].names.join(","));
check("no repair was needed", state[0] && state[0].notes.length === 0);
check("no source problem was reported", state[0] && state[0].problems.length === 0);
check("the sha256 check ran", !!(state[0] && state[0].sha), "no sha in the state");
check("the summary is on the page", text().includes("3 games"), text().slice(0, 160));
check("the file card is on the page", doc.querySelectorAll(".file").length === 1);
check("the output table lists the file", text().includes("lecture_001.pgn"));
check("the download button is enabled now", doc.getElementById("download-all").disabled === false);

/* changing the chunk size re-plans without re-reading the file */
doc.getElementById("games").value = "2";
doc.getElementById("games").dispatchEvent(new window.Event("input"));
await new Promise((resolve) => setTimeout(resolve, 400));
const state2 = window.pgnsplit.state();
check("two games per file makes two files", state2[0].files === 2, String(state2[0].files));
check("the names follow", state2[0].names.join(",") === "lecture_001.pgn,lecture_002.pgn",
      state2[0].names.join(","));

/* a second file with the same stem must not collide */
const file2 = new window.File([bytes], "lecture.pgn", { type: "application/x-chess-pgn" });
if (!file2.arrayBuffer) Object.defineProperty(file2, "arrayBuffer", { value: async () => bytes.buffer });
const input2 = doc.getElementById("file-input");
Object.defineProperty(input2, "files", { value: [file2], configurable: true });
input2.dispatchEvent(new window.Event("change"));
await new Promise((resolve) => setTimeout(resolve, 400));
const state3 = window.pgnsplit.state();
check("both files are queued", state3.length === 2, String(state3.length));
const allNames = state3.flatMap((s) => s.names);
check("no output name is used twice", new Set(allNames).size === allNames.length, allNames.join(","));
check("the second file got different names",
      state3[1].names[0] !== state3[0].names[0], state3[1].names.join(","));

/* a broken file must be reported, not crash */
const junk = new TextEncoder().encode("this is not a pgn at all\njust some text\n");
const file3 = new window.File([junk], "notes.txt", { type: "text/plain" });
if (!file3.arrayBuffer) Object.defineProperty(file3, "arrayBuffer", { value: async () => junk.buffer });
Object.defineProperty(input2, "files", { value: [file3], configurable: true });
input2.dispatchEvent(new window.Event("change"));
await new Promise((resolve) => setTimeout(resolve, 400));
const state4 = window.pgnsplit.state();
check("the junk file is marked as an error", state4[2] && state4[2].state === "error",
      JSON.stringify(state4[2]));
check("the error is shown on the page", text().includes("cannot split"));

/* removing a card */
const removeButtons = [...doc.querySelectorAll(".file header button")].filter((b) => b.textContent === "Remove");
removeButtons[0].dispatchEvent(new window.Event("click"));
check("a card can be removed", window.pgnsplit.state().length === 2,
      String(window.pgnsplit.state().length));

/* the zip really contains the chunks */
const zip = await window.pgnsplit.zipOf(0);
const zipBytes = new Uint8Array(await zip.blob.arrayBuffer());
check("the zip has content", zipBytes.length > 0, `${zipBytes.length} bytes`);
/* compression needs CompressionStream, which jsdom does not have; the deflate
   path is covered by tests/run-tests.mjs */
if (typeof window.CompressionStream === "function") {
  check("the zip is smaller than the input", zip.zipSize < zip.rawSize,
        `${zip.zipSize} vs ${zip.rawSize}`);
}

/* ---- what a download actually produces ---------------------------------- */
const downloads = [];
let lastBlob = null;
window.URL.createObjectURL = (blob) => { lastBlob = blob; return "blob:fake"; };
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
window.alert = () => {};

doc.getElementById("download-all").dispatchEvent(new window.Event("click"));
await new Promise((resolve) => setTimeout(resolve, 600));
check("downloading all produced one file", downloads.length === 1, downloads.join(","));
/* three games at two per file, so two chunks, so a zip */
check("two chunks are zipped into one download", downloads[0] === "pgnsplit-chunks.zip", downloads[0]);
check("the zip blob was handed over", !!lastBlob && lastBlob.size > 0);

/* one chunk only: the plain pgn, not a zip */
downloads.length = 0;
doc.getElementById("games").value = "64";
doc.getElementById("games").dispatchEvent(new window.Event("input"));
await new Promise((resolve) => setTimeout(resolve, 400));
const state5 = window.pgnsplit.state();
check("three games at 64 per file make one file", state5[0].files === 1, String(state5[0].files));
doc.querySelector(".file header button").dispatchEvent(new window.Event("click"));
await new Promise((resolve) => setTimeout(resolve, 600));
check("a single chunk is downloaded as the pgn itself",
      downloads[0] === "lecture_001.pgn", downloads.join(","));
const plain = new Uint8Array(await lastBlob.arrayBuffer());
check("the single download is a pgn, not a zip",
      Buffer.from(plain.subarray(0, 8)).toString() === '[Event "',
      Buffer.from(plain.subarray(0, 8)).toString());

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
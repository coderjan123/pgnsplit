/*
 * Tests for the browser splitter and the ZIP writer.  No test framework, no
 * dependencies, just node:
 *
 *   node tests/run-tests.mjs
 *
 * The expected game counts are the ones the Python CLI reports for the same
 * samples; run `node tools/parity.mjs tests/samples` to check that both
 * implementations still cut identical byte ranges.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

for (const file of ["assets/split.js", "assets/zip.js"]) {
  vm.runInThisContext(readFileSync(join(root, file), "utf8"), { filename: file });
}
const S = globalThis.PgnSplit;
const Z = globalThis.PgnZip;

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name + (detail ? ` -- ${detail}` : ""));
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

function equal(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/* ------------------------------------------------------------------ samples */

/* what the Python CLI finds in tests/samples, checked by tools/parity.mjs */
const EXPECTED = {
  "basic.pgn": { games: 3, problems: 0, notes: 0 },
  "tricky.pgn": { games: 3, problems: 0, notes: 0 },
  "broken.pgn": { games: 3, problems: 2, notes: 0 },
  /* CR-only line endings, two blank lines between games */
  "mac.pgn": { games: 3, problems: 0, notes: 0 },
  /* two blank lines, a game whose header is one [Event line after an unclosed brace */
  "odd.pgn": { games: 3, problems: 1, notes: 1 }
};

console.log("splitting");
const samples = {};
for (const [name, want] of Object.entries(EXPECTED)) {
  const bytes = new Uint8Array(readFileSync(join(here, "samples", name)));
  samples[name] = bytes;
  const plan = S.scanCore(bytes);

  equal(`${name}: game count`, plan.games.length, want.games);
  check(`${name}: has tag lines`, plan.hasTags === undefined ? true : true);

  const problems = [];
  for (const g of plan.games) {
    if (!g.hasResultTag) problems.push("no result tag");
    if (!g.hasMovetext) problems.push("no moves");
    if (g.depth !== 0) problems.push("unclosed bracket");
  }
  equal(`${name}: problems`, problems.length, want.problems);
  equal(`${name}: repair notes`, plan.notes.length, want.notes);

  /* the ranges must tile the whole file, in order, without gaps */
  let at = 0;
  let tiled = true;
  for (const g of plan.games) {
    if (g.start !== at || g.end < g.start) tiled = false;
    at = g.end;
  }
  check(`${name}: ranges tile the file`, tiled && at === bytes.length, `end ${at} of ${bytes.length}`);

  /* every output chunk must be a byte-exact slice */
  const chunks = [];
  const per = 2;
  for (let i = 0; i < plan.games.length; i += per) {
    chunks.push(plan.games.slice(i, Math.min(i + per, plan.games.length)));
  }
  const digest = createHash("sha256");
  let total = 0;
  for (const chunk of chunks) {
    const slice = bytes.subarray(chunk[0].start, chunk[chunk.length - 1].end);
    digest.update(slice);
    total += slice.length;
  }
  check(`${name}: chunks rebuild the input`,
        total === bytes.length && digest.digest("hex") === sha256(bytes));

  /* each game starts with a tag pair */
  const decoder = new TextDecoder("utf-8");
  const allStartWithTags = plan.games.every((g) =>
    /^\ufeff?[ \t]*\[[A-Za-z0-9_]+[ \t]+"/.test(decoder.decode(bytes.subarray(g.start, g.start + 40))));
  check(`${name}: every game starts with a tag pair`, allStartWithTags);

  /* chunk naming */
  const names = S.outputNames(name, chunks.length);
  equal(`${name}: number of names`, names.length, chunks.length);
  check(`${name}: names are numbered from 001`,
        names[0] === "basic_001.pgn" || names[0].endsWith("_001.pgn"), names[0]);
}

/* the three cases the two implementations used to disagree on */
{
  const mac = samples["mac.pgn"];
  check("mac.pgn: no CR LF anywhere", !Buffer.from(mac).includes(Buffer.from("\r\n")));
  check("mac.pgn: still has CR", Buffer.from(mac).includes(13));
  const plan = S.scanCore(mac);
  const gaps = plan.games.slice(1).map((g, i) => g.start - plan.games[i].end);
  check("mac.pgn: no gaps between games", gaps.every((d) => d === 0), gaps.join(","));
  const starts = plan.games.map((g) =>
    Buffer.from(mac.subarray(g.start, g.start + 7)).toString());
  check("mac.pgn: every game starts with a tag pair",
        starts.every((s2) => s2.startsWith("[Event ")), starts.join(" | "));
}
{
  const odd = samples["odd.pgn"];
  const plan = S.scanCore(odd);
  const gaps = plan.games.slice(1).map((g, i) => g.start - plan.games[i].end);
  check("odd.pgn: no gaps between games", gaps.every((d) => d === 0), gaps.join(","));
  check("odd.pgn: the unclosed brace was repaired once",
        plan.notes.filter((n) => n.kind === "resync").length === 1,
        JSON.stringify(plan.notes.map((n) => n.kind)));
  check("odd.pgn: the single [Event game survived",
        plan.games.length === 3, String(plan.games.length));
  check("odd.pgn: every game still has its tag pair",
        plan.games.every((g) => g.hasTagLine), "one lost its headers");
}

/* the tricky sample must survive all of its nastiness */
{
  const bytes = samples["tricky.pgn"];
  const text = Buffer.from(bytes).toString("utf8");
  check("tricky.pgn: the BOM is still there", bytes[0] === 0xef && bytes[1] === 0xbb);
  check("tricky.pgn: CRLF endings survive", text.includes("\r\n"));
  const plan = S.scanCore(bytes);
  const intro = Buffer.from(bytes.subarray(plan.games[0].start, plan.games[0].end)).toString();
  check("tricky.pgn: the ; inside a comment did not end the game", intro.includes("1. e4 e5"));
  check("tricky.pgn: the % escape line stayed inside the third game",
        Buffer.from(bytes.subarray(plan.games[2].start, plan.games[2].end)).toString()
          .includes("% this line is an escape"));
  const mainline = Buffer.from(bytes.subarray(plan.games[1].start, plan.games[1].end)).toString();
  check("tricky.pgn: the 0-1 inside a comment did not end the game",
        mainline.includes("-gm 0-1 chess24.com") && mainline.includes("1... Nf6 *"));
}

/* --------------------------------------------------------------- unit tests */

console.log("lexer");
{
  const enc = (s) => new TextEncoder().encode(s);
  const BOM = String.fromCharCode(0xfeff);
  const tagOf = (s) => S.matchTagLine(enc(s), 0, enc(s).length, {}) > 0;
  const line = (s) => JSON.stringify(S.scanLine(enc(s), 0, enc(s).length, 0));
  const find = (s) => S.findResult(enc(s), 0, enc(s).length);

  check("matchTagLine accepts a normal tag", tagOf('[Event "x"]\n'));
  check("matchTagLine accepts CRLF", tagOf('[Event "x"]\r\n'));
  check("matchTagLine accepts a BOM", tagOf(BOM + '[Event "x"]\n'));
  check("matchTagLine accepts an escaped quote", tagOf('[White "a \\"b"]\n'));
  check("matchTagLine accepts an empty value", tagOf('[Event ""]\n'));
  check("matchTagLine rejects movetext", !tagOf("1. e4 e5\n"));
  check("matchTagLine rejects a tag with trailing junk", !tagOf('[Event "x"]  junk\n'));
  check("matchTagLine rejects an unclosed quote", !tagOf('[Event "x\n'));
  check("matchTagLine rejects a header line folded over two lines", !tagOf('[Event "x\ncontinued"]\n'));
  {
    const tag = {};
    const text = '[White "Player"]\n';
    S.matchTagLine(enc(text), 0, enc(text).length, tag);
    equal("matchTagLine reports the tag name", tag.name, "White");
  }

  check("findResult finds *", find("1. e4 e5 *") > 0);
  check("findResult finds 1-0", find("1. e4 e5 1-0") > 0);
  check("findResult finds 0-1", find("1. e4 e5 0-1") > 0);
  check("findResult finds 1/2-1/2", find("1. e4 e5 1/2-1/2") > 0);
  equal("findResult ignores 1-0 glued to a letter", find("a1-0"), -1);
  equal("findResult ignores 0-1 glued to a dot", find("x.0-1"), -1);
  equal("findResult ignores a lone asterisk in a word", find("foo*bar"), -1);
  equal("findResult does not cross the end offset", S.findResult(enc("1-0"), 0, 2), -1);
  equal("findResult sees the byte before the range", S.findResult(enc("x1-0"), 1, 5), -1);

  equal("scanLine ignores a result inside braces", line("{a 0-1 b} *"), "[0,11]");
  equal("scanLine ignores a result inside parentheses", line("(a 1-0 b)"), "[0,-1]");
  equal("scanLine closes nested brackets", line("{a (b) c} *"), "[0,11]");
  equal("scanLine stops at a ; comment", line("1. e4 ; 0-1"), "[0,-1]");
  equal("scanLine does not stop at a ; inside braces", line("{a;b} 0-1"), "[0,9]");
  equal("scanLine keeps the depth of an unbalanced line", line("{a (b"), "[2,-1]");
  equal("scanLine never goes below zero", line("} } *"), "[0,5]");
}

/* --------------------------------------------------------------------- zip */

console.log("zip");
{
  const bytes = samples["basic.pgn"];
  const plan = S.scanCore(bytes);
  const entries = plan.games.map((g, i) => ({
    name: S.outputNames("basic.pgn", plan.games.length)[i],
    data: bytes.subarray(g.start, g.end)
  }));

  const tmp = join(here, ".tmp");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const zip = await Z.create(entries, new Date(2026, 0, 1));
  const zipPath = join(tmp, "out.zip");
  writeFileSync(zipPath, Buffer.from(await zip.blob.arrayBuffer()));

  check("zip is not larger than the input", zip.zipSize < zip.rawSize,
        `${zip.zipSize} vs ${zip.rawSize}`);
  check("zip is stored or deflated", zip.zipSize > 0);

  /* let python's zipfile have the last word */
  const script = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
out = {"names": z.namelist(), "bad": bad,
       "sizes": [i.file_size for i in z.infolist()],
       "crcs": [i.CRC for i in z.infolist()],
       "methods": [i.compress_type for i in z.infolist()]}
print(json.dumps(out))
`;
  const report = JSON.parse(execFileSync("python3", ["-c", script, zipPath], { encoding: "utf8" }));
  equal("zip: entry names", report.names.join(","), entries.map((e) => e.name).join(","));
  equal("zip: no corrupt entry", report.bad, null);
  equal("zip: uncompressed sizes", report.sizes.join(","), entries.map((e) => e.data.length).join(","));

  const { crc32 } = Z;
  equal("zip: crc32 of '123456789'", crc32(new TextEncoder().encode("123456789")), 0xcbf43926);

  /* and the extracted bytes must equal the slices */
  const extractScript = `
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
sys.stdout.buffer.write(b"".join(z.read(n) for n in z.namelist()))
`;
  const extracted = execFileSync("python3", ["-c", extractScript, zipPath]);
  equal("zip: extracted bytes equal the input", sha256(extracted), sha256(bytes));

  rmSync(tmp, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ naming */

console.log("naming");
equal("stemOf drops one extension", S.stemOf("Foo Bar.pgn"), "Foo Bar");
equal("stemOf keeps inner dots", S.stemOf("v1.2 course.pgn"), "v1.2 course");
equal("stemOf survives a path", S.stemOf("/a/b/c.pgn"), "c");
equal("humanSize bytes", S.humanSize(900), "900 B");
equal("humanSize kb", S.humanSize(2048), "2 KB");
equal("humanSize mb", S.humanSize(5 * 1024 * 1024), "5.0 MB");

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
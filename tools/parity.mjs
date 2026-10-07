/*
 * Parity check: does the browser splitter cut exactly the same byte ranges as
 * the Python CLI?  Run with node, pass any number of .pgn files or folders:
 *
 *   node tools/parity.mjs "~/CHESS/course" *.pgn
 *   find ~/pgns -name '*.pgn' > list.txt && node tools/parity.mjs @list.txt
 *
 * For every file it compares the number of games, every single byte range, and
 * the sha256 of the concatenated output chunks against the sha256 of the input.
 * A mismatch prints the first differing range.
 */
import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/* load assets/split.js, a classic script, into this module */
const context = vm.createContext({ Math, Date, performance, setTimeout, String, Object, Array, JSON });
new vm.Script(readFileSync(join(root, "assets", "split.js"), "utf8"), { filename: "split.js" })
  .runInContext(context);
const PgnSplit = context.PgnSplit;

const PY_HELPER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("ps", sys.argv[1])
ps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ps)
for path in json.load(open(sys.argv[2])):
    try:
        with open(path, "rb") as fh:
            data = fh.read()
        games, notes = ps.find_games(data)
        print(json.dumps({"path": path, "games": [[s, e] for s, e in games]}))
    except Exception as exc:
        print(json.dumps({"path": path, "error": "%s: %s" % (type(exc).__name__, exc)}))
`;

/* one python process for all files, because starting one per file is slow */
async function pythonRanges(files) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const script = join(here, ".parity_helper.py");
  const list = join(here, ".parity_list.json");
  writeFileSync(script, PY_HELPER);
  writeFileSync(list, JSON.stringify(files));
  try {
    const { stdout } = await run("python3", [script, join(root, "pgnsplit.py"), list],
                                 { maxBuffer: 1 << 30 });
    const out = new Map();
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      out.set(rec.path, rec);
    }
    return out;
  } finally {
    unlinkSync(script);
    unlinkSync(list);
  }
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function expand(args) {
  const files = [];
  for (const arg of args) {
    if (arg.startsWith("@")) {
      /* @list.txt: one path per line, for names with spaces or quotes */
      for (const line of readFileSync(arg.slice(1), "utf8").split("\n")) {
        if (line.trim()) files.push(...expand([line]));
      }
      continue;
    }
    const st = statSync(arg);
    if (st.isDirectory()) {
      for (const entry of readdirSync(arg)) {
        if (entry.toLowerCase().endsWith(".pgn")) files.push(join(arg, entry));
      }
    } else {
      files.push(arg);
    }
  }
  return files;
}

const files = expand(process.argv.slice(2));
if (files.length === 0) {
  console.error("usage: node tools/parity.mjs <file.pgn|dir|@list> ...");
  process.exit(2);
}

const python = await pythonRanges(files);
let failures = 0;

for (const file of files) {
  const rec = python.get(file);
  const name = basename(file);
  if (!rec) {
    failures++;
    console.log(`FAIL  no result from python   ${name}`);
    continue;
  }
  if (rec.error) {
    failures++;
    console.log(`FAIL  python: ${rec.error}  ${name}`);
    continue;
  }

  const bytes = new Uint8Array(readFileSync(file));
  const mine = PgnSplit.scanCore(bytes);
  const theirs = rec.games;
  if (!mine || !mine.games) {
    failures++;
    console.log(`FAIL  no result from the js splitter (${bytes.length} bytes)  ${name}`);
    continue;
  }

  const sameCount = mine.games.length === theirs.length;
  const sameRanges = sameCount && mine.games.every((g, i) => g.start === theirs[i][0] && g.end === theirs[i][1]);

  /* rebuild the chunks the way the app does and compare the bytes */
  const per = 64;
  const digest = createHash("sha256");
  let total = 0;
  for (let j = 0; j < mine.games.length; j += per) {
    const slice = bytes.subarray(mine.games[j].start, mine.games[Math.min(j + per, mine.games.length) - 1].end);
    digest.update(slice);
    total += slice.length;
  }
  const exact = total === bytes.length && digest.digest("hex") === sha256(bytes);

  const ok = sameCount && sameRanges && exact;
  if (!ok) failures++;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${String(mine.games.length).padStart(6)} games` +
    ` (python ${String(theirs.length).padStart(6)})  bytes ${exact ? "exact" : "DIFFERENT"}  ${name}`
  );

  if (!sameRanges && sameCount) {
    for (let i = 0; i < mine.games.length; i++) {
      if (mine.games[i].start !== theirs[i][0] || mine.games[i].end !== theirs[i][1]) {
        console.log(`       first difference at game ${i + 1}: js ${mine.games[i].start}-${mine.games[i].end}, python ${theirs[i][0]}-${theirs[i][1]}`);
        break;
      }
    }
  }
}

console.log(`\n${files.length} file(s), ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
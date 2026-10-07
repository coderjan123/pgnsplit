# pgnsplit

Split a PGN file into chunks of 64 games, so each chunk becomes one lichess
study (64 chapters is the limit per study).

Two front ends, one algorithm:

- **a web app** that runs entirely in your browser, and
- **a command line tool** in Python.

Nothing is uploaded anywhere. The web app has no build step, no dependencies and
makes no network requests at all; it also works when you open `index.html`
straight from disk.

```
853 games, 1.3 MB -> 14 files (64 per file, last one 21)
  wrote 14 file(s), sha256 round-trip OK
  python-chess: 853 games in the source, 853 in the output (OK)
```

## What "byte exact" means

Every output file is assembled from byte ranges of the input. The PGN is never
parsed and re-printed, so nothing can be dropped or rewritten along the way:

- comments, nested variations, NAGs (`$1`), `[%cal]`/`[%csl]`/`[%evp]`
  annotations and `{...}` prose survive untouched,
- tag pairs are never modified, in particular not renamed,
- the UTF-8 BOM, CRLF line endings and trailing whitespace stay as they were.

After writing, the SHA-256 of all output files concatenated is compared with the
SHA-256 of the input. If they ever differ, every file that was written is
deleted again. The web app shows the same check per file.

## The web app

Open it from the web (GitHub Pages, see the badge) or double-click
`index.html`. Then:

1. drop one or more `.pgn` files on the page,
2. check the plan: games found, files produced, notes about the source file,
3. **Download all as ZIP**, or tick *Save into a folder* to write the files
   directly into a directory of your choice (Chromium browsers only).

Optional: *Save into a folder* never overwrites an existing file, it skips it and
says so. In ZIP mode the browser picks the filename, as usual.

The app is also scriptable from the console:

```js
await pgnsplit.addBytes("lecture.pgn", new Uint8Array([...]));  // queue a file
pgnsplit.state();                                                 // what happened
await pgnsplit.zipOf(0);                                          // build the zip
```

## The command line tool

```sh
pgnsplit FILE.pgn              # 64 games per file -> FILE_001.pgn, FILE_002.pgn, ...
pgnsplit FILE.pgn --games 32   # different chunk size
pgnsplit FILE.pgn --outdir DIR  # write the chunks somewhere else
pgnsplit FILE.pgn --dry-run     # show the plan, write nothing
pgnsplit FILE.pgn --count       # just print the number of games
pgnsplit                        # interactive
cat FILE.pgn | pgnsplit -       # read from stdin
```

The tool never overwrites: if any target file exists it stops before writing
anything and lists the conflicts (`--force` or `--skip-existing` to override).
Each file is written as `NAME.pgn.part` and renamed afterwards, so an interrupted
run cannot leave a truncated PGN behind.

If [python-chess](https://pypi.org/project/chess/) is installed, the game count
of the source and of every output file is compared as a second opinion. The check
is informational; the SHA-256 round-trip is the guarantee.

## How games are found

Splitting on blank lines does not work: in the Chessable-style lecture PGNs a
single game can span hundreds of lines. Both implementations use the same small
lexer, which tracks

- `{ }` comments,
- `( )` variations,
- `;` end-of-line comments, which only count outside braces (several files in the
  wild contain a `;` inside a `{ }` comment),
- `%` escape lines,
- `[Tag "..."]` blocks, including a UTF-8 BOM on the first line,
- CR, LF and CRLF line endings, because a few exports still use classic mac ones.

A game ends at a result token (`1-0`, `0-1`, `1/2-1/2`, `*`) *outside* comments
and variations, or when a new tag block starts; a header block followed by two
blank lines and then more tags counts as a game of its own, even with no moves in
it, which is what python-chess and lichess do. A result inside a comment does not
count, which matters because those exports are full of lines such as
`{ ... @@StartBracket@@ -gm 0-1 chess24.com 2015 }`.

Some source files have unbalanced brackets (`({If} 1... Bxe4 {then}`, a `{` that
is never closed). There the splitter resynchronises at the next `[Event` line and
merges the resulting header-less continuation block back into the game it belongs
to. Every such repair is listed in the summary.

## Repository layout

```
index.html              the web app
.nojekyll               github pages: serve the files as they are, no jekyll
assets/split.js         the splitter, browser side
assets/zip.js           zip writer, browser side (CompressionStream, no library)
assets/app.js           the web app
assets/style.css
pgnsplit.py             the command line tool
tests/run-tests.mjs     node test runner, no dependencies
tests/run-ui-tests.mjs  the real page driven through jsdom (optional)
tests/samples/          small PGNs with the awkward cases in them
tools/parity.mjs        js vs python, byte range by byte range
```

No build step, no dependencies, nothing to install: the page is opened directly
or served by github pages from the repo root.

## Development

```sh
npm test                                        # 101 checks + js/python parity on the samples
npm run test:ui                                 # the real page in jsdom (needs npm install)
node tools/parity.mjs "~/CHESS/some course"     # any number of files or folders
find ~/pgns -name '*.pgn' > list.txt
node tools/parity.mjs @list.txt                 # for names with spaces
python3 -m http.server 8000                     # look at the app at localhost:8000
```

`tools/parity.mjs` needs `python3` and `node`; it runs both splitters over the
same files and compares every single byte range. The two implementations are kept
in sync this way, over thousands of real course exports rather than only the
samples. It has been run over 9000+ PGNs from two collections, including files
with CRLF and classic-CR line endings, a UTF-8 BOM, unbalanced brackets, result
tokens inside comments and header blocks without moves.

## Publishing on GitHub

There are no workflows in this repository. GitHub Pages serves the branch
directly:

**Settings → Pages → Build and deployment → Source: _Deploy from a branch_ →
Branch: `main`, Folder: `/ (root)` → Save.**

The page is then at <https://coderjan123.github.io/pgnsplit/>. There is nothing
to build: `index.html` and `assets/` sit in the root of the repository, and
`.nojekyll` tells GitHub to serve the files as they are instead of running them
through Jekyll.

Afterwards the usual loop is enough:

```sh
git add -A && git commit -m "..." && git push
```

Every push updates the site within a minute or two. Locally you do not need
GitHub at all:

```sh
xdg-open index.html            # works straight from disk
python3 -m http.server 8000    # or on localhost:8000
```

## Licence

MIT, see [LICENSE](LICENSE).
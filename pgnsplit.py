#!/usr/bin/env python3
"""pgnsplit - split a PGN file into chunks of N games, byte for byte.

Every output file is assembled from byte ranges of the input, so comments,
variations, NAGs, [%cal]/[%csl]/[%evp] annotations, the UTF-8 BOM and the
original line endings survive untouched.  Nothing is parsed and re-printed,
and header tags are never modified.

Usage examples:
    pgnsplit FILE.pgn              # 64 games per file, written to the cwd
    pgnsplit FILE.pgn --games 32   # different chunk size
    pgnsplit FILE.pgn --outdir DIR # write the chunks somewhere else
    pgnsplit FILE.pgn --dry-run    # show the plan, write nothing
    pgnsplit FILE.pgn --count      # just print the number of games
    pgnsplit                       # interactive mode
    cat FILE.pgn | pgnsplit -      # read from stdin
"""

from __future__ import annotations

import argparse
import hashlib
import io
import logging
import os
import re
import sys
from pathlib import Path

TOOL = "pgnsplit"
DEFAULT_GAMES_PER_FILE = 64

# A tag pair, e.g.  [White "1) Introduction"]   (escaped quotes tolerated).
# A leading UTF-8 BOM on the very first line of a file is tolerated as well.
TAG_RE = re.compile(rb'^(?:\xef\xbb\xbf)?[ \t]*\[[ \t]*[A-Za-z0-9_]+[ \t]+"(?:[^"\r\n]|\\.)*"[ \t]*\][ \t]*\r?\n?$')
# A whitespace-only line, with CR, LF or CRLF as the terminator
BLANK_RE = re.compile(rb"[ \t]*(?:\r\n|\r|\n)")
# The movetext terminator of a game
RESULT_RE = re.compile(rb'(?<![0-9A-Za-z.\-])(1-0|0-1|1/2-1/2|\*)(?![0-9A-Za-z.\-])')

MAX_LISTED_PROBLEMS = 12


# --------------------------------------------------------------------------- #
# splitting
# --------------------------------------------------------------------------- #

def _scan_line(line: bytes, depth: int) -> tuple[int, int | None]:
    """Walk one line, tracking {} comment and () variation nesting.

    Returns the nesting depth at the end of the line and, if the line holds a
    result token outside every comment and variation, the offset just past it.
    A result inside a comment (Chessable exports are full of them, e.g.
    `{ ... @@StartBracket@@ -josecuenca 0-1 chess24.com 2015 }`) must not end a
    game, which is why the token is looked for per depth-0 segment instead of
    over the whole line.
    """
    seg_start = 0
    seg_depth = depth
    limit = len(line)
    i = 0
    while i < limit:
        ch = line[i]
        if ch == 0x3B and depth == 0:  # ';' comment: the rest of the line is text
            limit = i
            break
        if ch in (0x7B, 0x28):  # { (
            if seg_depth == 0:
                m = RESULT_RE.search(line, seg_start, i)
                if m:
                    return depth, m.end()
            depth += 1
            seg_start = i + 1
            seg_depth = depth
        elif ch in (0x7D, 0x29):  # } )
            if seg_depth == 0:
                m = RESULT_RE.search(line, seg_start, i)
                if m:
                    return depth, m.end()
            depth = max(0, depth - 1)
            seg_start = i + 1
            seg_depth = depth
        i += 1
    if seg_depth == 0:
        m = RESULT_RE.search(line, seg_start, limit)
        if m:
            return depth, m.end()
    return depth, None


def _skip_blank(data: bytes, pos: int) -> int:
    """Return the first position after the run of blank lines at pos."""
    while True:
        m = BLANK_RE.match(data, pos)
        if not m:
            return pos
        pos = m.end()


def find_games(data: bytes) -> tuple[list[tuple[int, int]], list[str]]:
    """Cut data into contiguous (start, end) byte ranges, one per game.

    A game ends at a result token outside comments/variations, or when a new
    tag block starts in the middle of movetext.  Source files with unbalanced
    braces (Chessable exports contain things like `({If} 1... Bxe4 {then}`)
    are resynchronised at the next [Event line; every resync is reported.
    """
    games: list[tuple[int, int]] = []
    anomalies: list[str] = []
    start = 0
    depth = 0
    in_movetext = False
    in_tags = False
    blank_run = 0
    pos = 0

    for lineno, line in enumerate(data.splitlines(keepends=True), 1):
        stripped = line.strip()
        blank = not stripped

        if depth == 0 and TAG_RE.match(line):
            # a tag block that is followed by two blank lines and then more
            # tags is a game of its own, even without a single move
            if in_movetext or (in_tags and blank_run >= 2):
                games.append((start, pos))
                start = pos
                in_movetext = False
                in_tags = False
            in_tags = True
            blank_run = 0
            pos += len(line)
            continue

        if depth > 0 and stripped.startswith(b"[Event"):
            anomalies.append(
                f"line {lineno}: unclosed comment/variation before a new game, resynchronised"
            )
            games.append((start, pos))
            start = pos
            in_movetext = False
            in_tags = False
            depth = 0
            pos += len(line)
            continue

        if depth == 0:
            if stripped.startswith(b"%"):  # % escape line
                pos += len(line)
                continue
            if blank:
                blank_run += 1
            else:
                blank_run = 0
                in_movetext = True

        depth, result_at = _scan_line(line, depth)
        pos += len(line)
        if result_at is not None and in_movetext:
            # the game ends with its result token, at the end of that line
            games.append((start, pos))
            start = pos
            in_movetext = False
            in_tags = False

    if start < len(data):
        if not data[start:].strip() and games:
            # trailing blank lines belong to the last game, not to a new one
            games[-1] = (games[-1][0], len(data))
        else:
            games.append((start, len(data)))

    # Give the blank lines between two games to the first one, so that every
    # output file starts exactly at a tag pair.  Ranges stay contiguous.
    for i in range(len(games) - 1):
        s, e = games[i]
        e = _skip_blank(data, e)
        games[i] = (s, e)
        games[i + 1] = (e, games[i + 1][1])

    # A block without any tag pair is not a game of its own but the continuation
    # of the previous one.  This happens when a source file has unbalanced
    # brackets, e.g. a main line that continues after a variation was closed.
    merged: list[tuple[int, int]] = []
    for s, e in games:
        has_tags = any(TAG_RE.match(line) for line in data[s:e].splitlines())
        if merged and not has_tags:
            anomalies.append(
                f"offset {s}: block without headers merged into the previous game"
            )
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    games = merged

    return games, anomalies


def inspect_games(data: bytes, games: list[tuple[int, int]]) -> list[str]:
    """Report games with a missing Result tag, no movetext or unclosed braces."""
    problems: list[str] = []
    for i, (s, e) in enumerate(games, 1):
        chunk = data[s:e]
        if not chunk.strip():
            problems.append(f"game {i}: empty")
            continue
        if not re.search(rb'^[ \t]*\[[ \t]*Result[ \t]+"', chunk, re.M):
            problems.append(f"game {i}: no [Result] tag")
        movetext = False
        depth = 0
        for line in chunk.splitlines(keepends=True):
            if depth == 0 and TAG_RE.match(line):
                continue
            if depth == 0 and line.strip():
                movetext = True
            depth, _ = _scan_line(line, depth)
        if not movetext:
            problems.append(f"game {i}: header block only, no moves")
        if depth != 0:
            problems.append(f"game {i}: {depth} unclosed comment/variation bracket(s)")
    return problems


# --------------------------------------------------------------------------- #
# verification
# --------------------------------------------------------------------------- #

def count_games_with_chess(data: bytes) -> tuple[int | None, str | None]:
    """Count games with python-chess, if it is installed.  Best effort only."""
    try:
        import chess.pgn  # noqa: F401
    except ImportError:
        return None, "python-chess is not installed"

    logging.getLogger("chess.pgn").setLevel(logging.CRITICAL)
    count = 0
    handle = io.StringIO(data.decode("utf-8", errors="replace"))
    err = io.StringIO()
    try:
        with contextlib_redirect_stderr(err):
            while True:
                game = chess.pgn.read_game(handle)
                if game is None:
                    break
                count += 1
    except Exception as exc:  # malformed files make python-chess bail out
        return count, f"python-chess stopped early: {exc}"
    return count, None


class contextlib_redirect_stderr:
    def __init__(self, stream):
        self.stream = stream

    def __enter__(self):
        self.old = sys.stderr
        sys.stderr = self.stream
        return self.stream

    def __exit__(self, *exc):
        sys.stderr = self.old
        return False


# --------------------------------------------------------------------------- #
# output
# --------------------------------------------------------------------------- #

def human_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    for unit in ("KB", "MB", "GB"):
        n /= 1024.0
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "KB" else f"{n:.1f} {unit}"
    return f"{n:.1f} GB"


def output_paths(stem: str, count: int, outdir: Path) -> list[Path]:
    width = max(3, len(str(count)))
    return [outdir / f"{stem}_{i:0{width}d}.pgn" for i in range(1, count + 1)]


def print_plan(source: Path, data: bytes, games: list[tuple[int, int]], chunks, targets) -> None:
    n = len(games)
    per_file = len(chunks[0])
    if len(chunks[-1]) != per_file:
        detail = f"{per_file} per file, last one {len(chunks[-1])}"
    else:
        detail = f"{per_file} per file"
    print(f"{source}")
    print(f"  {n} games, {human_size(len(data))} -> {len(chunks)} files ({detail})")
    print()
    print(f"  {'#':>3}  {'file':<52} {'games':>5}  {'size':>9}")
    for i, (chunk, path) in enumerate(zip(chunks, targets), 1):
        size = sum(e - s for s, e in chunk)
        name = path.name
        if len(name) > 52:
            name = name[:24] + "..." + name[-25:]
        print(f"  {i:>3}  {name:<52} {len(chunk):>5}  {human_size(size):>9}")


def write_chunks(data: bytes, chunks, targets: list[Path]) -> str | None:
    """Write every chunk atomically.  Returns an error message, or None."""
    digest = hashlib.sha256()
    written = 0
    tmp_files: list[Path] = []
    try:
        for chunk, target in zip(chunks, targets):
            payload = data[chunk[0][0]:chunk[-1][1]]
            tmp = target.parent / (target.name + ".part")
            tmp_files.append(tmp)
            with open(tmp, "wb") as fh:
                fh.write(payload)
            os.replace(tmp, target)
            digest.update(payload)
            written += len(payload)
    except OSError as exc:
        for tmp in tmp_files:
            tmp.unlink(missing_ok=True)
        return str(exc)

    if written != len(data) or digest.hexdigest() != hashlib.sha256(data).hexdigest():
        for target in targets:
            target.unlink(missing_ok=True)
        return ("sha256 round-trip failed, nothing kept "
                f"(wrote {written} of {len(data)} bytes)")
    return None


# --------------------------------------------------------------------------- #
# driver
# --------------------------------------------------------------------------- #

def plan_for(data: bytes, games_per_file: int, source: str, outdir: Path):
    games, anomalies = find_games(data)
    if not games:
        return None
    chunks = [games[i:i + games_per_file] for i in range(0, len(games), games_per_file)]
    stem = Path(source).stem or "games"
    targets = output_paths(stem, len(chunks), outdir)
    return games, chunks, targets, anomalies


def run(path_arg: str, args) -> int:
    if path_arg == "-":
        data = sys.stdin.buffer.read()
        source = Path(args.name)
    else:
        source = Path(os.path.expanduser(path_arg.strip().strip("'\"")))
        if not source.is_file():
            print(f"{TOOL}: {source}: no such file", file=sys.stderr)
            return 1
        data = source.read_bytes()

    if not data:
        print(f"{TOOL}: {source} is empty", file=sys.stderr)
        return 1
    if data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff"):
        print(f"{TOOL}: {source}: UTF-16 PGNs are not supported", file=sys.stderr)
        return 1
    if b"\x00" in data:
        print(f"{TOOL}: {source}: looks like UTF-16, aborting", file=sys.stderr)
        return 1

    planned = plan_for(data, args.games, str(source), Path(args.outdir))
    if planned is None:
        print(f"{TOOL}: {source}: no games found", file=sys.stderr)
        return 1
    games, chunks, targets, anomalies = planned

    if not any(TAG_RE.match(line) for line in data.splitlines()):
        print(f"{TOOL}: {source}: no [Tag \"...\"] headers found, cannot split", file=sys.stderr)
        return 1

    if args.count:
        print(f"{len(games)} games, {human_size(len(data))}")
        return 0

    print_plan(source, data, games, chunks, targets)
    print()

    problems = inspect_games(data, games)
    if anomalies:
        print(f"  {len(anomalies)} note(s) about the source file:")
        for note in anomalies[:MAX_LISTED_PROBLEMS]:
            print(f"    - {note}")
        if len(anomalies) > MAX_LISTED_PROBLEMS:
            print(f"    ... and {len(anomalies) - MAX_LISTED_PROBLEMS} more")
        print()
    if problems:
        print(f"  {len(problems)} problem(s) in the source file (games are copied anyway):")
        for note in problems[:MAX_LISTED_PROBLEMS]:
            print(f"    - {note}")
        if len(problems) > MAX_LISTED_PROBLEMS:
            print(f"    ... and {len(problems) - MAX_LISTED_PROBLEMS} more")
        print()

    if args.dry_run:
        print("dry run, nothing written")
        return 0

    existing = [t for t in targets if t.exists()]
    if existing and not (args.force or args.skip_existing):
        print(f"{TOOL}: refusing to overwrite, these files already exist:", file=sys.stderr)
        for t in existing[:MAX_LISTED_PROBLEMS]:
            print(f"  {t}", file=sys.stderr)
        if len(existing) > MAX_LISTED_PROBLEMS:
            print(f"  ... and {len(existing) - MAX_LISTED_PROBLEMS} more", file=sys.stderr)
        print("use --force to overwrite or --skip-existing to leave them alone", file=sys.stderr)
        return 1

    if args.skip_existing:
        pairs = [(c, t) for c, t in zip(chunks, targets) if not t.exists()]
        chunks = [c for c, _ in pairs]
        targets = [t for _, t in pairs]
        if not chunks:
            print(f"{TOOL}: every output file already exists, nothing to do")
            return 0

    try:
        targets[0].parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"{TOOL}: {exc}", file=sys.stderr)
        return 1

    error = write_chunks(data, chunks, targets)
    if error:
        print(f"{TOOL}: {error}", file=sys.stderr)
        return 1

    print(f"  wrote {len(targets)} file(s), sha256 round-trip OK")

    if not args.no_verify:
        ref, ref_err = count_games_with_chess(data)
        if ref is None:
            print(f"  verification skipped ({ref_err})")
        else:
            total = 0
            broken = []
            if ref_err:
                broken.append(f"source: {ref_err}")
            for chunk, target in zip(chunks, targets):
                payload = data[chunk[0][0]:chunk[-1][1]]
                got, err = count_games_with_chess(payload)
                if err:
                    broken.append(f"{target.name}: {err}")
                total += got or 0
            if broken:
                # python-chess itself chokes on these files, so its counts
                # cannot be compared; the sha256 round-trip above still holds
                print(f"  python-chess cannot parse the source cleanly, "
                      f"count check skipped ({len(broken)} problem(s)):")
                for line in broken[:MAX_LISTED_PROBLEMS]:
                    print(f"    - {line}")
                if len(broken) > MAX_LISTED_PROBLEMS:
                    print(f"    ... and {len(broken) - MAX_LISTED_PROBLEMS} more")
            else:
                status = "OK" if total == len(games) else "MISMATCH"
                print(f"  python-chess: {ref} games in the source, "
                      f"{total} in the output ({status})")
                if total != len(games):
                    print(f"  {TOOL}: {len(games)} games found here, python-chess sees "
                          f"{total}; the source file is inconsistent, check it before importing",
                          file=sys.stderr)

    return 0


def interactive(args) -> int:
    print(f"{TOOL}: give me a .pgn file (empty line to quit)")
    while True:
        try:
            answer = input("PGN file: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if not answer:
            return 0
        try:
            games = input("Games per file [%d]: " % args.games).strip()
            args.games = int(games) if games else args.games
        except ValueError:
            print("not a number, keeping %d" % args.games)
        status = run(answer, args)
        if status == 0:
            print()
            try:
                again = input("Another file? [y/N] ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                print()
                return 0
            if again not in ("y", "yes"):
                return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(
        prog=TOOL,
        description="Split a PGN into files of N games, preserving every byte.",
    )
    parser.add_argument("file", nargs="?", help="input .pgn, or - for stdin")
    parser.add_argument("-n", "--games", type=int, default=DEFAULT_GAMES_PER_FILE,
                        metavar="N", help="games per output file (default: 64)")
    parser.add_argument("-o", "--outdir", default=".", metavar="DIR",
                        help="directory for the output files (default: .)")
    parser.add_argument("-d", "--dry-run", action="store_true",
                        help="show the plan without writing")
    parser.add_argument("-c", "--count", action="store_true",
                        help="only print the number of games")
    parser.add_argument("-f", "--force", action="store_true",
                        help="overwrite existing output files")
    parser.add_argument("--skip-existing", action="store_true",
                        help="leave existing output files alone, write the rest")
    parser.add_argument("--no-verify", action="store_true",
                        help="skip the python-chess game count check")
    parser.add_argument("--name", default="stdin.pgn", metavar="STEM",
                        help="name for the output files when reading stdin")
    args = parser.parse_args(argv)

    if args.games < 1:
        parser.error("--games must be 1 or more")
    if args.file is None or args.file == "-i" or args.file == "--interactive":
        return interactive(args)
    return run(args.file, args)


if __name__ == "__main__":
    sys.exit(main())
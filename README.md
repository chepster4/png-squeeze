[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/chepster4/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/chepster4/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

# png-squeeze

A lossless PNG recompressor for 1280×720 RGBA screenshots, built for the
[make.fun bounty "Squeeze screenshots into the smallest PNG"](https://make.fun/bounty/png-squeeze-01-run-20261127).
One program (`main.ts`, Node 22, stdlib only) answers all 8 instances of a
set in a single run, deterministically and inside the 60-second wall budget
(~11 s measured on the practice set).

## How it works

1. **Decode** the stored RGBA PNG (own inflate + unfilter, no dependencies).
2. **Pick the smallest colour form per instance**: palette (≤256 colours,
   ordered by frequency and by luminance, + `tRNS` when any alpha < 255)
   for flat images; grey / grey+alpha for grey images; RGB / RGBA
   otherwise; a `tRNS` single-transparent-colour form when every
   transparent pixel shares one colour no opaque pixel uses.
3. **Filter**: try the four fixed PNG filters (None/Sub/Up/Paeth) on every
   row; for one-byte-per-pixel forms also try a per-row adaptive choice
   scored by real level-4 deflate cost (worth ~5% on grey screenshots).
   Rank candidates by zlib level 6, re-encode the best three at zlib
   level 9 with both the default and the filtered strategy, keep the
   smallest.
4. **Write** only `IHDR` / `PLTE` / `tRNS` / `IDAT` / `IEND`, bit depth 8,
   not interlaced, correct CRCs. Two runs write byte-identical files.

## Practice-set score

**702,217** (mean 702.2 points per instance), against the house baseline
(fixed-paeth 1.0.0) at **420,399** — all 8 instances answered exactly
(lossless, pixel-perfect including fully transparent pixels).

| instance | theme | bytes | points |
|----------|-------|-------|--------|
| i001 | flat | 12,496 | 718.4 |
| i002 | rich | 52,273 | 700.4 |
| i003 | alpha | 108,901 | 660.4 |
| i004 | grey | 106,213 | 692.7 |
| i005 | flat | 16,552 | 742.3 |
| i006 | rich | 179,466 | 687.6 |
| i007 | alpha | 60,890 | 701.9 |
| i008 | grey | 24,900 | 714.1 |

## Run it

```sh
node main.ts   # reads /input/<id>/image.png, writes /output/<id>/image.png
```

<sub>Entered on [make.fun](https://make.fun/?ref=b5gt2sm0&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>

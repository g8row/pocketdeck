# Conventions

## Branches and tags

- `main` only moves to states that were tested on the tablet. Work happens on short-lived branches:
  `feat/<area>-<thing>`, `fix/<area>-<thing>`, `bringup/<hardware>`, `docs/<topic>`, `chore/<topic>`.
- Frozen: `archive/mainline-bringup`, tag `android-era-final` (the repo before the PocketDeck restructure).
- Releases `v0.N.0` after device verification; the release notes carry the BUILDINFO of what was tested.
- Existing tags stay (scripts download from them): `bootscreens-ridge-1`, `mainline-test-1`, `stock-partitions-1`.

## Commits

Subject prefix by area: `kernel:` `boot:` `rootfs:` `ui:` `deckd:` `tools:` `docs:` `repo:`, or a hardware area
(`power:` `display:` `wifi:` `bluetooth:` …). Imperative, lower case after the prefix.

## Docs

- One live hardware status: [hardware/status.md](../hardware/status.md), stating the build it was verified on.
- Research notes start with `Status: current` or say what superseded them.
- No dated file names; history lives in git (see [history](../history/README.md)).
- Adding a doc means adding its line to [docs/index.md](../index.md).
- Install docs use `pd` commands; when a flag changes, `pd help` is the source of truth.
- Lessons that cost time go into [lessons.md](lessons.md), one or two lines each.

## Privacy

The repo is public. No host names, user names, home or build paths, LAN addresses, e-mail addresses or keys in
tracked files; per-developer settings go into `.pd.env` (untracked). Partition dumps (`backup/`) never leave the
machine: they hold the IMEI and calibration data.

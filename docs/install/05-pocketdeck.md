# Stage 5 · PocketDeck

Stage 5 of 5 · **you are here:** Linux on the eMMC, `healthy` · **you need:** stage 4, Bun + Rust musl target + Zig
on the host · **you end with:** the deck UI on the panel, deckd feeding it, hot reload from the host
Previous: [04](04-linux.md) · If it fails: [recovery](recovery.md)

## 1. The UI on the tablet

```sh
./pd deploy
```

Builds the PocketJS Linux host (`pocketjs-kiosk`, static aarch64 musl, DRM/KMS scanout, Goodix touch) and the `deck`
app bundle (`pocketjs/apps/desk`), copies both to `/opt/pocketjs`, installs the OpenRC service `pocketdeck-ui`
with its options in `/etc/conf.d/pocketdeck-ui` (touch masking for the cracked glass, power key behaviour), and
starts it. A tablet that still has the pre-rename `pocketjs` service is migrated. `pd log ui` follows its log.

## 2. deckd on the host

```sh
./pd deckd              # foreground: watches the app sources, rebuilds and pushes on save (~2 s)
./pd deckd --install    # Linux: systemd user service started with the graphical session
```

deckd keeps an `ssh -R 7777` tunnel to the tablet (`DECKD_SSH`, default `root@172.16.42.1`); the UI dials
127.0.0.1:7777 on its side. **Deck Studio** at <http://127.0.0.1:7778/> edits panes, deck tiles and the accent
(`deckd/deck.config.json`, git-ignored). Everything deckd provides and every setting:
[deckd/README.md](../../deckd/README.md).

## 3. Claude Code hooks (optional; the CLAUDE pane needs them)

Merge into `~/.claude/settings.json` (absolute path to your checkout):

```json
{ "hooks": {
  "SessionStart":     [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/pocketdeck/deckd/hooks/claude-hook.sh", "timeout": 3 }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/pocketdeck/deckd/hooks/claude-hook.sh", "timeout": 3 }] }],
  "PreToolUse":       [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/pocketdeck/deckd/hooks/claude-hook.sh", "timeout": 3 }] }],
  "Notification":     [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/pocketdeck/deckd/hooks/claude-hook.sh", "timeout": 3 }] }],
  "Stop":             [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/pocketdeck/deckd/hooks/claude-hook.sh", "timeout": 3 }] }],
  "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/pocketdeck/deckd/hooks/claude-hook.sh", "timeout": 3 }] }]
} }
```

The hook posts the event to deckd with a 1 s timeout and always exits 0. Approving permission prompts from the
tablet (experimental): register `deckd/hooks/claude-gate.sh` as a `PermissionRequest` hook with timeout ≥ 30; with
no tablet or no answer Claude Code shows its normal prompt.

Done when: the panel shows the deck, the header link dot is on, saving a file in `pocketjs/apps/desk/` reloads
the tablet, and a deck tile runs its action on the host.

Day-to-day work after this: [dev/workflow.md](../dev/workflow.md).

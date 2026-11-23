#!/bin/sh
# Claude Code hook → deckd. Forwards the hook's JSON (stdin) to deckd.
# Never blocks or fails the session: 1 s timeout, all errors swallowed.
curl -s -m 1 -X POST -H 'content-type: application/json' --data-binary @- \
  http://127.0.0.1:7778/claude >/dev/null 2>&1 || true
exit 0

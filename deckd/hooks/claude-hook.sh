#!/bin/sh
# Claude Code hook → deskd. Forwards the hook's JSON (stdin) to the desk daemon.
# Never blocks or fails the session: 1 s timeout, all errors swallowed.
curl -s -m 1 -X POST -H 'content-type: application/json' --data-binary @- \
  http://127.0.0.1:7778/claude >/dev/null 2>&1 || true
exit 0

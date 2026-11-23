#!/bin/sh
# Claude Code PermissionRequest hook → deskd permission gate.
# deskd answers with an allow/deny decision tapped on the tablet, or with an
# empty body (gate off, no tablet, or timeout ≤ 25 s; 50 s for questions and plans) → we print nothing and
# Claude Code shows its normal permission prompt. If deskd is down, curl fails
# instantly and the same fallback applies. Never fails the session.
curl -s -m 58 -X POST -H 'content-type: application/json' --data-binary @- \
  http://127.0.0.1:7778/claude/permission 2>/dev/null || true
exit 0

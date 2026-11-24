#!/bin/sh
# Repo hygiene checks, run by CI and before pushing:
#   1. relative links in tracked Markdown resolve
#   2. no stale pre-restructure names outside archive/ and the plan
#   3. no personal data patterns (home paths, LAN addresses, e-mail); extra local patterns, one regex per line, in
#      the untracked file .private-patterns (host names etc. that must not appear in the public tree)
#   4. shell scripts parse
set -u
cd "$(dirname "$0")/.." || exit 1
fail=0
bad() { echo "FAIL: $*"; fail=1; }

# 1. links
git ls-files '*.md' | grep -v -e '^pocketjs' -e '^device/wcn/' | python3 -I -c '
import os, re, sys, urllib.parse
bad = 0
for f in sys.stdin.read().split():
    text = open(f, encoding="utf-8").read()
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    for m in re.finditer(r"\]\(([^)\s]+)\)", text):
        t = m.group(1)
        if re.match(r"[a-z]+:", t) or t.startswith("#"):
            continue
        p = urllib.parse.unquote(t.split("#")[0])
        if not os.path.exists(os.path.normpath(os.path.join(os.path.dirname(f), p))):
            print(f"FAIL: broken link in {f}: {t}"); bad = 1
sys.exit(bad)' || fail=1

# 2. stale names (deliberate exceptions: archive/, the restructure plan, history, migration code)
git grep -n -I -E 'deskd|DESKD_|desk-companion|Desk Studio|docs/mainline|mainline/scripts|\bmainline/' -- . \
	':!archive' ':!pocketjs' ':!RESTRUCTURE-PLAN.md' ':!docs/history' ':!tools/check-repo.sh' ':!device/wcn' \
	':!deckd/env.ts' ':!deckd/deckconfig.ts' ':!deckd/linux/install.sh' ':!.gitignore' ':!tools/linux-test.sh' |
	grep -v -e 'mt6735-mainline' -e 'android-era-final' && bad "stale names above"

# 3. privacy
P='/home/[a-z]|/Users/[a-zA-Z]|192\.168\.[0-9]|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|org|net|io|xyz)'
git grep -n -I -E "$P" -- . ':!pocketjs' ':!device/wcn' ':!tools/check-repo.sh' | grep -v -E 'noreply@|users\.noreply|git@github' && bad "personal data patterns above"
if [ -f .private-patterns ]; then
	git grep -n -I -i -E -f .private-patterns -- . ':!pocketjs' && bad "private patterns above"
fi

# 4. shell syntax
for f in pd tools/*.sh tools/fbusb device/build/build.sh device/build/wcn-build.sh device/rootfs/build-rootfs.sh \
	device/u-boot/build-uboot.sh device/gpu/build-mesa.sh deckd/linux/install.sh deckd/hooks/*.sh; do
	case $(head -n1 "$f") in *bash*) bash -n "$f" ;; *) sh -n "$f" ;; esac || bad "syntax: $f"
done
bash -n device/build/build-in-docker.sh || bad "syntax: build-in-docker.sh"

[ $fail = 0 ] && echo "repo checks passed"
exit $fail

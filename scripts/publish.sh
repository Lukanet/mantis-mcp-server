#!/usr/bin/env bash
#
# Release @lukanet/mantis-mcp-server. This is the only way to publish.
#
#   bash scripts/publish.sh patch|minor|major
#
# The next version is computed from the version currently on npm, never from
# package.json, so a number cannot be skipped. The script moves the
# [Unreleased] section of CHANGELOG.md under that version, commits, tags and
# pushes. The tag starts .github/workflows/publish.yml, which publishes over
# trusted publishing (OIDC) - no npm token exists anywhere. The script then
# waits until the version shows up on npm.
#
# Nothing is changed before you confirm by typing the version back.
#
set -euo pipefail

REGISTRY="https://registry.npmjs.org/"
BRANCH_EXPECTED="main"
ACTIONS_URL="https://github.com/Lukanet/mantis-mcp-server/actions/workflows/publish.yml"
WAIT_SECONDS=600

die()  { printf '\n  ГРЕШКА: %s\n\n' "$1" >&2; exit 1; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

case "${1:-}" in
  patch|minor|major) BUMP="$1" ;;
  -h|--help)         usage 0 ;;
  *)                 usage 1 ;;
esac

cd "$(dirname "$0")/.."
PKG_NAME=$(node -p "require('./package.json').name")

# ---------------------------------------------------------------- проверки
step "Проверки"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "$BRANCH_EXPECTED" ] || die "клонът е '$BRANCH', публикува се само от '$BRANCH_EXPECTED'"
ok "клон: $BRANCH"

if [ -n "$(git status --porcelain)" ]; then
  git status --short | sed 's/^/        /'
  die "има некомитнати промени - публикува се само комитнато състояние"
fi
ok "работното дърво е чисто"

git fetch --quiet --tags origin "$BRANCH"
[ -z "$(git rev-list HEAD..origin/"$BRANCH")" ] || die "origin/$BRANCH има къмити, които липсват локално - направи git pull"
ok "в синхрон с origin/$BRANCH"

# ------------------------------------------------------------------ версия
step "Версия"

PUBLISHED=$(npm view "$PKG_NAME" version --registry="$REGISTRY" 2>/dev/null) \
  || die "не мога да прочета публикуваната версия от npm"
VERSION=$(node -e '
  const [major, minor, patch] = process.argv[1].split(".").map(Number);
  const next = { major: [major + 1, 0, 0], minor: [major, minor + 1, 0], patch: [major, minor, patch + 1] };
  console.log(next[process.argv[2]].join("."));
' "$PUBLISHED" "$BUMP")
ok "в npm:  $PUBLISHED"
ok "нова:   $VERSION ($BUMP)"

if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  die "таг v$VERSION вече съществува, но версията не е в npm - вероятно CI не е успял.
  Виж $ACTIONS_URL, оправи причината и пусни отново провалилия се run (Re-run jobs)."
fi
ok "таг v$VERSION е свободен"

# ---------------------------------------------------------------- changelog
grep -q '^## \[Unreleased\]' CHANGELOG.md || die "в CHANGELOG.md няма секция '## [Unreleased]' - опиши промените там"
grep -q "^## \[$VERSION\]" CHANGELOG.md && die "CHANGELOG.md вече има секция [$VERSION]"
UNRELEASED=$(awk '/^## \[Unreleased\]/{on=1; next} /^## \[/{on=0} on' CHANGELOG.md)
[ -n "$(printf '%s' "$UNRELEASED" | tr -d '[:space:]')" ] || die "секцията [Unreleased] в CHANGELOG.md е празна"
ok "CHANGELOG.md има описание на промените"

# ------------------------------------------------------------------- билд
# Същото ще направи и CI; тук е, за да се хване счупен билд преди тага.
step "Билд и съдържание на пакета"
rm -rf dist
npm run build >/dev/null
[ -f dist/index.js ] || die "билдът не създаде dist/index.js"
ok "dist/ е прекомпилиран от нулата"

TARBALL=$(npm pack --silent)
FILES=$(tar tzf "$TARBALL")
rm -f "$TARBALL"
printf '%s\n' "$FILES" | sed 's/^/        /'
if printf '%s\n' "$FILES" | grep -qE '(^|/)(\.env|\.npmrc|\.mcp\.json|logs/)'; then
  die "в пакета влизат файлове, които не бива да са публични - провери 'files' в package.json"
fi
ok "няма .env / .npmrc / .mcp.json / logs в пакета"

# ------------------------------------------------------------ потвърждение
step "Промени в $VERSION"
printf '%s\n' "$UNRELEASED" | sed 's/^/    /'
printf '\n  Публикуването е необратимо. Напиши "%s" за потвърждение: ' "$VERSION"
read -r CONFIRM
[ "$CONFIRM" = "$VERSION" ] || die "прекратено, нищо не е променено"

# ----------------------------------------------------------------- release
step "Release $VERSION"
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
TODAY=$(date +%Y-%m-%d)
node -e '
  const fs = require("fs");
  const text = fs.readFileSync("CHANGELOG.md", "utf8");
  fs.writeFileSync("CHANGELOG.md", text.replace(/^## \[Unreleased\]$/m, `## [Unreleased]\n\n## [${process.argv[1]}] - ${process.argv[2]}`));
' "$VERSION" "$TODAY"
git add package.json CHANGELOG.md
git commit --quiet -m "Release $VERSION"
git tag -a "v$VERSION" -m "Release $VERSION"
ok "къмит и таг v$VERSION"

# --atomic: или и клонът, и тагът стигат до GitHub, или нищо.
git push --quiet --atomic origin "$BRANCH" "v$VERSION"
ok "изпратено в GitHub - CI публикува"

# ------------------------------------------------------------------ чакане
step "Чакам $PKG_NAME@$VERSION да се появи в npm"
DEADLINE=$((SECONDS + WAIT_SECONDS))
until npm view "$PKG_NAME@$VERSION" version --registry="$REGISTRY" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    die "след $((WAIT_SECONDS / 60)) минути версията още я няма в npm. Виж $ACTIONS_URL
  Тагът е изпратен; след като оправиш причината, пусни отново провалилия се run."
  fi
  printf '.'
  sleep 15
done
printf '\n'
ok "публикувано: $PKG_NAME@$VERSION"
cat <<EOF

  Клиентите, които ползват пакета през npx, вземат новата версия при следващо
  стартиране; вече пуснатите MCP процеси трябва да се рестартират.
EOF

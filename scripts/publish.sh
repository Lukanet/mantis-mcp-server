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
RUNS_API="https://api.github.com/repos/Lukanet/mantis-mcp-server/actions/workflows/publish.yml/runs"
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

# CI инсталира с `npm ci`, което работи само с lockfile от repo-то и в синхрон
# с package.json. Без тази проверка грешката излиза чак в CI (така се провали 0.6.0).
git ls-files --error-unmatch package-lock.json >/dev/null 2>&1 \
  || die "package-lock.json не е в git - npm ci в CI няма да тръгне"
npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null
if ! git diff --quiet -- package-lock.json; then
  git checkout -- package-lock.json
  die "package-lock.json не съответства на package.json - пусни npm install и къмитни lockfile-а"
fi
ok "package-lock.json е в git и съответства на package.json"

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

# Таг без версия в npm значи, че предишният опит е стигнал до GitHub, но CI не
# е публикувал. "Re-run" в GitHub не помага, ако грешката е в самия workflow -
# той се пуска от тагнатия къмит. Затова тагът се мести на HEAD (с поправката)
# и се изпраща наново; номерът остава същият, защото в npm нищо не е заето.
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  PKG_VERSION=$(node -p "require('./package.json').version")
  [ "$PKG_VERSION" = "$VERSION" ] \
    || die "таг v$VERSION съществува, но package.json е $PKG_VERSION - не знам как се е стигнало дотук, оправи ръчно"
  git merge-base --is-ancestor "v$VERSION" HEAD \
    || die "таг v$VERSION не е предшественик на HEAD - оправи ръчно"
  step "Повторен опит за $VERSION"
  ok "таг v$VERSION е изпратен, но $VERSION не е в npm - предишният CI run не е публикувал"
  ok "тагът ще бъде преместен от $(git rev-parse --short "v$VERSION^{commit}") на $(git rev-parse --short HEAD) и CI ще тръгне наново"
  if [ "$(git rev-parse "v$VERSION^{commit}")" = "$(git rev-parse HEAD)" ]; then
    ok "(HEAD е същият къмит - полезно само ако причината е била извън repo-то, напр. настройка в npmjs.com)"
  fi
  printf '\n  Напиши "%s" за потвърждение: ' "$VERSION"
  read -r CONFIRM
  [ "$CONFIRM" = "$VERSION" ] || die "прекратено, нищо не е променено"
  PUSHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  git push --quiet origin "$BRANCH"
  git push --quiet origin ":refs/tags/v$VERSION"
  git tag -f -a "v$VERSION" -m "Release $VERSION" >/dev/null
  git push --quiet origin "v$VERSION"
  ok "тагът v$VERSION е преместен и изпратен - CI публикува"
  RETRY=1
else
  RETRY=0
  ok "таг v$VERSION е свободен"
fi

if [ "$RETRY" -eq 0 ]; then

  # ---------------------------------------------------------------- changelog
  grep -q '^## \[Unreleased\]' CHANGELOG.md || die "в CHANGELOG.md няма секция '## [Unreleased]' - опиши промените там"
  grep -q "^## \[$VERSION\]" CHANGELOG.md && die "CHANGELOG.md вече има секция [$VERSION]"
  UNRELEASED=$(awk '/^## \[Unreleased\]/{on=1; next} /^## \[/{on=0} on' CHANGELOG.md)
  [ -n "$(printf '%s' "$UNRELEASED" | tr -d '[:space:]')" ] || die "секцията [Unreleased] в CHANGELOG.md е празна"
  ok "CHANGELOG.md има описание на промените"

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
  git add package.json package-lock.json CHANGELOG.md
  git commit --quiet -m "Release $VERSION"
  git tag -a "v$VERSION" -m "Release $VERSION"
  ok "къмит и таг v$VERSION"

  # --atomic: или и клонът, и тагът стигат до GitHub, или нищо.
  PUSHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  git push --quiet --atomic origin "$BRANCH" "v$VERSION"
  ok "изпратено в GitHub - CI публикува"

fi

# ------------------------------------------------------------------ чакане
# Статусът на CI се чете от публичния GitHub API (без вход), за да се спре
# веднага при провал, вместо да се чака до изтичане на времето.
ci_conclusion() {
  curl -fsS "$RUNS_API?event=push&branch=v$VERSION&per_page=1" 2>/dev/null | node -e '
    let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
      try {
        const run = JSON.parse(d).workflow_runs?.[0];
        if (run && new Date(run.created_at) >= new Date(process.argv[1]))
          console.log(`${run.status} ${run.conclusion ?? ""} ${run.html_url}`);
      } catch {}
    });
  ' "$PUSHED_AT"
}

step "Чакам $PKG_NAME@$VERSION да се появи в npm"
DEADLINE=$((SECONDS + WAIT_SECONDS))
until npm view "$PKG_NAME@$VERSION" version --registry="$REGISTRY" >/dev/null 2>&1; do
  read -r CI_STATUS CI_CONCLUSION CI_URL <<<"$(ci_conclusion)" || true
  if [ "${CI_STATUS:-}" = "completed" ] && [ "${CI_CONCLUSION:-}" != "success" ]; then
    printf '\n'
    die "CI завърши с '$CI_CONCLUSION': $CI_URL
  Нищо не е публикувано. Оправи причината, къмитни и пусни скрипта отново със
  същия аргумент - той ще премести тага v$VERSION и ще опита пак."
  fi
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    die "след $((WAIT_SECONDS / 60)) минути версията още я няма в npm. Виж $ACTIONS_URL"
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

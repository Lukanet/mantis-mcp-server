#!/usr/bin/env bash
#
# Publish @lukanet/mantis-mcp-server to the public npm registry.
#
#   bash scripts/publish.sh                  # pre-flight checks + pack preview, publishes nothing
#   bash scripts/publish.sh --bump minor     # bump the version first, then preview
#   bash scripts/publish.sh --publish        # actually publish the current version
#
# Publishing is irreversible: a version number can never be reused, and
# `npm unpublish` only works within 72 hours. Nothing is sent to the registry
# unless --publish is passed explicitly.
#
set -euo pipefail

REGISTRY="https://registry.npmjs.org/"
EXPECTED_BRANCH="main"

BUMP=""
DO_PUBLISH=0
ALLOW_DIRTY=0
ALLOW_ANY_BRANCH=0
NO_GIT_TAG=0

die()  { printf '\n  ГРЕШКА: %s\n\n' "$1" >&2; exit 1; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
warn() { printf '  \033[33mвним\033[0m  %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Опции:
  --bump <patch|minor|major>  Вдига версията (npm version) преди проверките.
  --publish                   Публикува. Без този флаг скриптът само проверява.
  --no-git-tag                При --bump не прави git комит и таг.
  --allow-dirty               Разрешава незакомитнати промени.
  --allow-any-branch          Разрешава клон, различен от main.
  -h, --help                  Тази помощ.
EOF
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --bump)            BUMP="${2:-}"; shift 2 ;;
    --publish)         DO_PUBLISH=1; shift ;;
    --no-git-tag)      NO_GIT_TAG=1; shift ;;
    --allow-dirty)     ALLOW_DIRTY=1; shift ;;
    --allow-any-branch) ALLOW_ANY_BRANCH=1; shift ;;
    -h|--help)         usage ;;
    *)                 die "непознат аргумент: $1 (виж --help)" ;;
  esac
done

cd "$(dirname "$0")/.."
command -v jq >/dev/null || die "нужен е jq"

PKG_NAME=$(jq -r .name package.json)

# ---------------------------------------------------------------- проверки
step "Проверки преди публикуване"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "$EXPECTED_BRANCH" ] && [ "$ALLOW_ANY_BRANCH" -eq 0 ]; then
  die "клонът е '$BRANCH', а не '$EXPECTED_BRANCH' (--allow-any-branch за да продължиш)"
fi
ok "клон: $BRANCH"

if [ -n "$(git status --porcelain)" ] && [ "$ALLOW_DIRTY" -eq 0 ]; then
  git status --short | sed 's/^/        /'
  die "работното дърво не е чисто — публикувай само комитнато състояние (--allow-dirty за да пренебрегнеш)"
fi
ok "работното дърво е чисто"

if ! NPM_USER=$(npm whoami --registry="$REGISTRY" 2>/dev/null); then
  die "не си логнат в npm — пусни: npm login --registry=$REGISTRY"
fi
ok "npm потребител: $NPM_USER"

# ------------------------------------------------------------------- bump
if [ -n "$BUMP" ]; then
  case "$BUMP" in
    patch|minor|major) ;;
    *) die "--bump приема patch, minor или major (подадено: $BUMP)" ;;
  esac
  step "Вдигане на версията ($BUMP)"
  if [ "$NO_GIT_TAG" -eq 1 ]; then
    npm version "$BUMP" --no-git-tag-version >/dev/null
    ok "версията е вдигната (без git комит и таг)"
  else
    npm version "$BUMP" >/dev/null
    ok "версията е вдигната, направен е git комит и таг"
  fi
fi

VERSION=$(jq -r .version package.json)

# ------------------------------------------------- версията свободна ли е
step "Състояние в регистъра"
PUBLISHED_LATEST=$(npm view "$PKG_NAME" version --registry="$REGISTRY" 2>/dev/null || echo "-")
ok "в npm сега: $PUBLISHED_LATEST"
ok "локално:    $VERSION"

if npm view "$PKG_NAME@$VERSION" version --registry="$REGISTRY" >/dev/null 2>&1; then
  die "версия $VERSION вече е публикувана — вдигни номера (--bump patch|minor|major)"
fi
ok "версия $VERSION е свободна"

# ------------------------------------------------------------------ билд
# npm publish НЕ билдва сам (няма prepublishOnly), затова билдваме тук —
# иначе в пакета отива старият dist/ с новия номер на версията.
step "Билд"
rm -rf dist
npm run build >/dev/null
[ -f dist/index.js ] || die "билдът не създаде dist/index.js"
ok "dist/ е прекомпилиран от нулата"

# --------------------------------------------------------------- преглед
step "Какво ще влезе в пакета"
TARBALL=$(npm pack --silent)
tar tzf "$TARBALL" | sed 's/^/        /'
SIZE=$(du -h "$TARBALL" | cut -f1)
ok "$TARBALL ($SIZE)"

# Дребна проверка да не изтекат тайни през грешно настроен "files".
if tar tzf "$TARBALL" | grep -qE '(^|/)(\.env|\.npmrc|\.mcp\.json|logs/)'; then
  rm -f "$TARBALL"
  die "в пакета влизат файлове, които не бива да са публични — провери 'files' в package.json"
fi
ok "няма .env / .npmrc / .mcp.json / logs в пакета"

# ------------------------------------------------------------ публикуване
if [ "$DO_PUBLISH" -eq 0 ]; then
  rm -f "$TARBALL"
  step "Нищо не е публикувано"
  cat <<EOF
  Проверките минаха. За да публикуваш $PKG_NAME@$VERSION:

      bash scripts/publish.sh --publish

  След това не забравяй: git push && git push --tags
EOF
  exit 0
fi

step "Публикуване на $PKG_NAME@$VERSION"
printf '  Това е необратимо. Напиши "%s" за потвърждение: ' "$VERSION"
read -r CONFIRM
[ "$CONFIRM" = "$VERSION" ] || { rm -f "$TARBALL"; die "прекратено"; }

npm publish "$TARBALL" --access public --registry="$REGISTRY"
rm -f "$TARBALL"

ok "публикувано: $PKG_NAME@$VERSION"
cat <<EOF

  Остава:
      git push && git push --tags
      npx -y $PKG_NAME@$VERSION --help   # проверка, че се вдига от регистъра

  Клиентите, които ползват пакета през npx, ще вземат новата версия при
  следващо стартиране; вече пуснатите процеси трябва да се рестартират.
EOF

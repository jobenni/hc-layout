#!/usr/bin/env bash
# Installe le layout Benni et ses mods dans Herdr, puis l'active.
#   ./install.sh                 depuis un clone du dépôt
#   HERDR_APP_HOME=... ./install.sh   pour viser un autre dossier Herdr
set -euo pipefail

REPO_URL="https://github.com/jobenni/hc-layout.git"
LAYOUT_NAME="benni"
MODS=(benni-spaces benni-settings benni-toast tabs-graph gh-issues git-graph claude-workflow)

APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
BACKUP_DIR="$APP_HOME/backups/hc-layout-$(date +%Y%m%d-%H%M%S)"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

find_source_dir() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  if [[ -n "$script_dir" && -f "$script_dir/layouts/$LAYOUT_NAME.json" ]]; then
    echo "$script_dir"
    return
  fi
  command -v git >/dev/null || die "git est requis pour récupérer le dépôt"
  local clone_dir
  clone_dir="$(mktemp -d)"
  say "Clonage de $REPO_URL" >&2
  git clone --depth 1 --quiet "$REPO_URL" "$clone_dir" || die "clonage impossible"
  echo "$clone_dir"
}

check_prerequisites() {
  command -v herdr-app >/dev/null || warn "herdr-app introuvable dans le PATH : installe Herdr d'abord"
  command -v gh >/dev/null || warn "gh introuvable : les panneaux Issues et les cartes PR ne marcheront pas"
  if command -v gh >/dev/null && ! gh auth status >/dev/null 2>&1; then
    warn "gh n'est pas connecté : lance 'gh auth login'"
  fi
}

backup_if_different() {
  local source="$1" target="$2" relative="$3"
  [[ -e "$target" ]] || return 0
  diff -rq -x 'gpui-kit.d.ts' -x 'types' "$source" "$target" >/dev/null 2>&1 && return 0
  mkdir -p "$BACKUP_DIR/$(dirname "$relative")"
  cp -R "$target" "$BACKUP_DIR/$relative"
  say "Sauvegarde de $relative dans $BACKUP_DIR"
}

install_mod() {
  local source_dir="$1" mod="$2"
  local source="$source_dir/mods/$mod" target="$APP_HOME/mods/$mod"
  [[ -d "$source" ]] || die "mod absent du dépôt : $mod"
  backup_if_different "$source" "$target" "mods/$mod"
  rm -rf "$target"
  mkdir -p "$APP_HOME/mods"
  cp -R "$source" "$target"
  rm -f "$target/gpui-kit.d.ts"
  if command -v herdr-app >/dev/null; then
    herdr-app check "$target" >/dev/null 2>&1 || warn "herdr-app check signale un problème sur $mod"
  fi
  say "Mod $mod installé"
}

install_layout() {
  local source_dir="$1"
  local source="$source_dir/layouts/$LAYOUT_NAME.json" target="$APP_HOME/layouts/$LAYOUT_NAME.json"
  backup_if_different "$source" "$target" "layouts/$LAYOUT_NAME.json"
  mkdir -p "$APP_HOME/layouts"
  cp "$source" "$target"
  say "Layout $LAYOUT_NAME installé"
}

set_layout_in_shared_json() {
  local shared="$APP_HOME/shared.json"
  [[ -f "$shared" ]] || echo '{}' >"$shared"
  if command -v jq >/dev/null; then
    local tmp
    tmp="$(mktemp)"
    jq --arg name "$LAYOUT_NAME" '.layout = $name' "$shared" >"$tmp" && mv "$tmp" "$shared"
  elif command -v python3 >/dev/null; then
    python3 -I - "$shared" "$LAYOUT_NAME" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
data["layout"] = name
with open(path, "w") as f:
    json.dump(data, f)
PY
  else
    warn "ni jq ni python3 : choisis le layout « $LAYOUT_NAME » à la main dans Herdr"
    return
  fi
  say "Layout $LAYOUT_NAME choisi pour le prochain lancement de Herdr"
}

record_installed_commit() {
  local source_dir="$1" commit
  commit="$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)"
  printf '{"repo":"%s","commit":"%s","installed_at":"%s"}\n' "$REPO_URL" "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$APP_HOME/hc-layout.json"
}

activate_layout() {
  if command -v herdr-app >/dev/null && herdr-app do layout.switch --name "$LAYOUT_NAME" >/dev/null 2>&1; then
    say "Layout $LAYOUT_NAME affiché dans la fenêtre ouverte"
  else
    set_layout_in_shared_json
  fi
}

main() {
  check_prerequisites
  local source_dir
  source_dir="$(find_source_dir)"
  say "Installation depuis $source_dir vers $APP_HOME"
  for mod in "${MODS[@]}"; do
    install_mod "$source_dir" "$mod"
  done
  install_layout "$source_dir"
  record_installed_commit "$source_dir"
  activate_layout
  say "Terminé."
}

main "$@"

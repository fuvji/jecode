#!/bin/sh
# jetcode bootstrap for macOS, Linux and SteamOS.
#
#   curl -fsSL https://raw.githubusercontent.com/fuvji/jetcode/main/installer/install.sh | sh
#
# What it does:
#   1. Detects the OS, CPU architecture, distro and (on Linux) whether the
#      system is immutable, such as SteamOS. Everything installs under
#      $JETCODE_HOME, so read-only roots are untouched.
#   2. Reuses Bun when it is already installed and installs it locally when
#      it is not. No sudo, no system service, no global npm package.
#   3. Builds the CLI for this machine only (--single) and links it as
#      `jetcode` in $JETCODE_HOME/bin.
#
# Environment:
#   JETCODE_HOME   install root (default: ~/.jetcode)
#   JETCODE_REPO   git remote (default: https://github.com/fuvji/jetcode.git)
#   JETCODE_REF    branch or tag to check out (default: current, then main)
#
# Flags:
#   --desktop   also build the Electron desktop app (heavy, optional)
#   --baseline  force the non-AVX2 build (auto-detected on x64)
#   --dir PATH  use an existing checkout instead of cloning

set -eu

REPO="${JETCODE_REPO:-https://github.com/fuvji/jetcode.git}"
REF="${JETCODE_REF:-}"
HOME_DIR="${JETCODE_HOME:-$HOME/.jetcode}"
SRC="$HOME_DIR/src"
BIN_DIR="$HOME_DIR/bin"
DESKTOP=0
BASELINE=0
CHECKOUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --desktop) DESKTOP=1; shift ;;
    --baseline) BASELINE=1; shift ;;
    --dir)
      [ $# -ge 2 ] || { echo "install: --dir needs a path" >&2; exit 1; }
      CHECKOUT="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) shift ;;
  esac
done

say() { printf '\033[38;5;183m%s\033[0m\n' "$*"; }
ok() { printf '  \033[38;5;114m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[38;5;221m!\033[0m %s\n' "$*"; }
die() {
  printf '\033[38;5;203mjetcode install: %s\033[0m\n' "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

# ---------- 1. Detect ----------

case "$(uname -s 2>/dev/null || echo unknown)" in
  Darwin) OS="darwin"; OS_LABEL="macOS" ;;
  Linux) OS="linux"; OS_LABEL="Linux" ;;
  *) die "unsupported system: $(uname -s). Windows users run installer/install.ps1 in PowerShell." ;;
esac

case "$(uname -m 2>/dev/null || echo unknown)" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

DISTRO=""
IMMUTABLE=0
if [ "$OS" = "linux" ] && [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  DISTRO="$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-${NAME:-Linux}}")"
  if grep -Eqi '^(ID|ID_LIKE)=.*(steamos|steam)' /etc/os-release 2>/dev/null || [ -f /etc/steamos-release ]; then
    OS_LABEL="SteamOS"
    IMMUTABLE=1
  fi
  if [ -f /run/ostree-booted ] || [ -d /sysroot/ostree ]; then IMMUTABLE=1; fi
fi

if [ "$OS" = "darwin" ]; then
  OS_LABEL="macOS $(sw_vers -productVersion 2>/dev/null || echo '')"
fi

AVX2=0
if [ "$ARCH" = "x64" ] && [ "$OS" = "linux" ] && [ -r /proc/cpuinfo ] && grep -qm1 ' avx2' /proc/cpuinfo; then
  AVX2=1
elif [ "$ARCH" = "x64" ] && [ "$OS" = "darwin" ]; then
  AVX2=1
fi
if [ "$BASELINE" = "1" ]; then AVX2=0; fi

say "jetcode installer"
ok "$OS_LABEL · $ARCH · $([ "$AVX2" = 1 ] && echo 'AVX2 build' || echo 'baseline build')"
if [ -n "$DISTRO" ]; then ok "$DISTRO"; fi
if [ "$IMMUTABLE" = "1" ]; then ok "immutable system detected — installing under $HOME_DIR"; fi
if [ "$OS" = "linux" ] && grep -qi microsoft /proc/version 2>/dev/null; then
  warn "WSL detected. jetcode installs inside this distribution; run it from the Linux shell."
fi

# ---------- 2. Prepare ----------

have git || die "git is required. Install it with your package manager, then rerun."
have curl || die "curl is required. Install it with your package manager, then rerun."

BUN=""
if have bun; then
  BUN="$(command -v bun)"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
fi

if [ -z "$BUN" ]; then
  say "Installing Bun locally…"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || die "Bun install failed. Install Bun from https://bun.sh and rerun."
  if [ -x "$HOME/.bun/bin/bun" ]; then
    BUN="$HOME/.bun/bin/bun"
  else
    die "Bun was not found after install. Add ~/.bun/bin to PATH and rerun."
  fi
fi
ok "bun $("$BUN" --version)"

# ---------- 3. Checkout ----------

if [ -n "$CHECKOUT" ]; then
  SRC="$CHECKOUT"
  [ -f "$SRC/package.json" ] || die "$CHECKOUT does not look like the jetcode repository"
  ok "using existing checkout at $SRC"
elif [ -d "$SRC/.git" ]; then
  say "Updating $SRC…"
  git -C "$SRC" fetch --depth 1 origin >/dev/null 2>&1 || warn "fetch failed; building the current checkout"
  TARGET="${REF:-$(git -C "$SRC" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
  git -C "$SRC" checkout "$TARGET" >/dev/null 2>&1 || true
  git -C "$SRC" pull --ff-only >/dev/null 2>&1 || warn "pull skipped (local changes or offline)"
  ok "checkout ready"
else
  say "Cloning jetcode into $SRC…"
  mkdir -p "$(dirname "$SRC")"
  if [ -n "$REF" ]; then
    git clone --depth 1 --branch "$REF" "$REPO" "$SRC" >/dev/null 2>&1 || die "clone failed: $REPO"
  else
    git clone --depth 1 "$REPO" "$SRC" >/dev/null 2>&1 || die "clone failed: $REPO"
  fi
  ok "cloned"
fi

mkdir -p "$BIN_DIR"

# ---------- 4. Build ----------

say "Installing dependencies…"
(cd "$SRC" && "$BUN" install) || die "dependency install failed"

say "Building the jetcode CLI…"
BUILD_ARGS="--single"
if [ "$ARCH" = "x64" ] && [ "$AVX2" = "0" ]; then BUILD_ARGS="$BUILD_ARGS --baseline"; fi
(cd "$SRC" && "$BUN" --cwd packages/cli build $BUILD_ARGS) || die "CLI build failed"

BINARY="$(find "$SRC/packages/cli/dist" -type f -name opencode 2>/dev/null | head -n 1 || true)"
[ -n "$BINARY" ] || die "build finished but no CLI binary was found under packages/cli/dist"
chmod 755 "$BINARY" 2>/dev/null || true
ln -sf "$BINARY" "$BIN_DIR/jetcode"
ok "linked $BIN_DIR/jetcode"

if [ "$DESKTOP" = "1" ]; then
  say "Building the desktop app…"
  (cd "$SRC" && "$BUN" --cwd packages/desktop build) || warn "desktop build failed; the CLI is still installed"
fi

# ---------- 5. PATH ----------

case ":${PATH}:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR is already on PATH" ;;
  *)
    PROFILE=""
    case "${SHELL:-}" in
      */zsh) PROFILE="$HOME/.zshrc" ;;
      */bash) PROFILE="$HOME/.bashrc" ;;
      */fish) PROFILE="$HOME/.config/fish/config.fish" ;;
    esac
    if [ -n "$PROFILE" ]; then
      LINE="export PATH=\"$BIN_DIR:\$PATH\""
      case "$PROFILE" in
        *fish) LINE="fish_add_path \"$BIN_DIR\"" ;;
      esac
      if ! grep -qsF "$BIN_DIR" "$PROFILE" 2>/dev/null; then
        mkdir -p "$(dirname "$PROFILE")"
        printf '\n# jetcode\n%s\n' "$LINE" >>"$PROFILE"
        ok "added $BIN_DIR to $PROFILE"
      fi
    fi
    warn "open a new shell, or run: export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

say "Done. Run: jetcode --version"
say "Then open a project and run: jetcode"

#!/usr/bin/env bash
set -euo pipefail

mode="inventory"
if [[ "${1:-}" == "--root-only" ]]; then
  mode="root-only"
  shift
fi

start_path="${1:-$PWD}"
if [[ -f "$start_path" ]]; then
  start_path=$(dirname "$start_path")
fi

if project_root=$(git -C "$start_path" rev-parse --show-toplevel 2>/dev/null); then
  :
else
  start_root=$(cd "$start_path" && pwd -P)
  project_root="$start_root"
  search_root="$start_root"
  while [[ "$search_root" != "/" ]]; do
    if [[ -f "$search_root/package.json" || -f "$search_root/pyproject.toml" || -f "$search_root/go.mod" || -f "$search_root/Cargo.toml" || -d "$search_root/.planning" ]]; then
      project_root="$search_root"
      break
    fi
    search_root=$(dirname "$search_root")
  done
fi

if [[ "$mode" == "root-only" ]]; then
  printf '%s\n' "$project_root"
  exit 0
fi

printf 'PROJECT_ROOT\t%s\n' "$project_root"

if git -C "$project_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf '\n[GIT_HEAD]\n'
  git -C "$project_root" branch --show-current
  git -C "$project_root" rev-parse --short HEAD 2>/dev/null || true
  printf '\n[GIT_STATUS]\n'
  git -C "$project_root" status --short
  printf '\n[RECENT_COMMITS]\n'
  git -C "$project_root" log -8 --date=short --pretty=format:'%h\t%ad\t%s' 2>/dev/null || true
  printf '\n'
  printf '\n[GIT_CHANGED_FILES]\n'
  git -C "$project_root" diff --name-status HEAD 2>/dev/null || true
  printf '\n[GIT_DIFF_STAT]\n'
  git -C "$project_root" diff --stat HEAD 2>/dev/null || true
fi

declare -A seen=()

emit_file() {
  local classification="$1"
  local path="$2"
  [[ -f "$path" ]] || return 0
  local relative="${path#"$project_root"/}"
  [[ -z "${seen[$relative]:-}" ]] || return 0
  seen[$relative]=1
  local size modified
  size=$(stat -c '%s' "$path" 2>/dev/null || printf '0')
  modified=$(stat -c '%y' "$path" 2>/dev/null | cut -d'.' -f1 || true)
  printf '%s\t%s\t%s\t%s\n' "$classification" "$relative" "$size" "$modified"
}

printf '\n[HIGH_VALUE_FILES]\n'

for name in AGENTS.md CLAUDE.md PI.md README.md README.zh-CN.md package.json pyproject.toml go.mod Cargo.toml; do
  emit_file contract "$project_root/$name"
done

for name in STATE.md PROJECT.md ROADMAP.md REQUIREMENTS.md RETROSPECTIVE.md config.json; do
  emit_file gsd-core "$project_root/.planning/$name"
done

if [[ -d "$project_root/.planning" ]]; then
  while IFS= read -r path; do
    case "${path##*/}" in
      VERIFICATION.md|UAT.md|SUMMARY.md) classification=gsd-evidence ;;
      PLAN.md|CONTEXT.md|RESEARCH.md|UI-SPEC.md|AI-SPEC.md) classification=gsd-plan ;;
      *) classification=gsd-other ;;
    esac
    emit_file "$classification" "$path"
  done < <(find "$project_root/.planning" -type f \( -name 'VERIFICATION.md' -o -name 'UAT.md' -o -name 'SUMMARY.md' -o -name 'PLAN.md' -o -name 'CONTEXT.md' -o -name 'RESEARCH.md' -o -name 'UI-SPEC.md' -o -name 'AI-SPEC.md' \) -print | sort)
fi

if [[ -d "$project_root/docs/planning" ]]; then
  while IFS= read -r path; do
    emit_file docs-planning "$path"
  done < <(find "$project_root/docs/planning" -type f -name '*.md' -print | sort)
fi

for path in "$project_root"/docs/architecture*.md "$project_root"/docs/*architecture*.md "$project_root"/docs/adr/*.md "$project_root"/docs/decisions/*.md; do
  emit_file architecture "$path"
done

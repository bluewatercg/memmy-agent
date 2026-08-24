#!/usr/bin/env bash
# memmy-cli-status — 监控各 Agent CLI 的工作目录与记忆服务连接状态
#
# 输出每个已接入 Agent 的：进程是否在跑 → 工作目录 → 会话文件最新活动
# → 记忆库最近写入 → 连接状态。
#
# 用法:
#   scripts/memmy-cli-status.sh            # 标准输出
#   scripts/memmy-cli-status.sh --json     # JSON 输出（便于接监控）
#   scripts/memmy-cli-status.sh --watch 5  # 每 5 秒刷新
#
# 环境变量:
#   MEMORY_VOLUME  记忆库 docker 卷名（默认 memmy-memory_memory-data）
set -uo pipefail

MEMORY_VOLUME="${MEMORY_VOLUME:-memmy-memory_memory-data}"
NOW_EPOCH=$(date +%s)

# 每行: sourceId:显示名:进程匹配模式(pgrep -f ERE):会话目录(可为空)
AGENTS=(
  "codex:Codex CLI:node .*[/ ]codex$|codex-code-mode-host|[/.]codex/bin/[^ ]*codex:/root/.codex/sessions"
  "freebuff:FreeBuff:[/.]freebuff$:"
  "claude_code:Claude Code:[/.]claude$|claude-code:|/root/.claude/projects"
  "omp:Pi / OMP:[/.]omni$|[/.]omp$|[/.]pi$:/root/.pi/agent/sessions"
  "hermes:Hermes:[/.]hermes$:/root/.hermes"
  "opencode:Opencode:[/.]opencode$:/root/.opencode"
  "openclaw:OpenClaw:[/.]openclaw$:/root/.openclaw"
  "cursor:Cursor:[/.]cursor$:/root/.cursor"
  "workbuddy:WorkBuddy:[/.]workbuddy$:/root/.workbuddy"
)

rel_time() {
  local epoch="${1:-0}" diff
  [ "$epoch" -gt 0 ] 2>/dev/null || epoch=0
  [ "$epoch" -eq 0 ] && { echo "—"; return; }
  diff=$(( NOW_EPOCH - epoch ))
  [ "$diff" -lt 0 ] && diff=0
  if [ "$diff" -lt 60 ]; then echo "${diff}秒前"; return; fi
  if [ "$diff" -lt 3600 ]; then echo "$(( diff / 60 ))分钟前"; return; fi
  if [ "$diff" -lt 86400 ]; then echo "$(( diff / 3600 ))小时前"; return; fi
  echo "$(( diff / 86400 ))天前"
}

iso_to_epoch() {
  # 2026-08-24T07:57:47.558Z -> epoch；空输入返回 0
  [ -n "${1:-}" ] || { echo 0; return; }
  date -u -d "${1%%.*}Z" +%s 2>/dev/null || echo 0
}

# ---- 记忆库最近写入（docker volume + sqlite 只读）----
# 输出: source|last_written_iso 行
memory_last_written() {
  docker run --rm -v "${MEMORY_VOLUME}:/data" alpine sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /data/memory.sqlite "SELECT agent_id, MAX(created_at) FROM memories GROUP BY agent_id;"
  ' 2>/dev/null
}

# ---- 进程 → 工作目录 ----
# 输入进程匹配模式，输出 "pid|cwd" 行（去重 cwd）
proc_cwd() {
  local pattern="$1" pid cwd seen=""
  for pid in $(pgrep -f "$pattern" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || continue
    case "|$seen|" in *"|$cwd|"*) continue ;; esac
    seen="$seen|$cwd"
    echo "$pid|$cwd"
  done
}

# ---- 会话目录最新文件 mtime (epoch) ----
latest_session_mtime() {
  local dir="${1:-}" f
  [ -n "$dir" ] && [ -d "$dir" ] || { echo 0; return; }
  f=$(find "$dir" -name "*.jsonl" -printf "%T@ %p\n" 2>/dev/null | sort -rn | head -1 | cut -d' ' -f1)
  echo "${f%%.*}"
}

json_out=""
is_num() { [[ "${1:-}" =~ ^[0-9]+$ ]]; }

print_row() {
  local src="$1" name="$2" pid_cwd="$3" session_epoch="$4" mem_iso="$5"
  local mem_epoch session_txt mem_txt proc_txt cwd_txt status
  mem_epoch=$(iso_to_epoch "$mem_iso")
  session_txt=$(rel_time "$session_epoch")
  mem_txt=$(rel_time "$mem_epoch")
  if [ -n "$pid_cwd" ]; then
    proc_txt="● 运行中"
    cwd_txt="${pid_cwd#*|}"
    if is_num "$mem_epoch" && [ "$mem_epoch" -gt 0 ] && [ $(( NOW_EPOCH - mem_epoch )) -lt 3600 ]; then
      status="已连接记忆"
    else
      status="运行中·未写记忆"
    fi
  else
    proc_txt="— 未运行"
    cwd_txt="—"
    status="—"
  fi
  printf "%-14s %-10s %-22s %-34s %-10s %s\n" "$name" "$proc_txt" "$cwd_txt" "$session_txt" "$mem_txt" "$status"
}

main() {
  local mode="${1:-table}"
  if [ "$mode" = "table" ]; then
    printf "%-14s %-10s %-22s %-34s %-10s %s\n" "Agent" "进程" "工作目录" "会话文件活动" "记忆写入" "状态"
    printf '%s\n' "------------------------------------------------------------------------------------------------------------"
  fi

  local mem_map mem_line src name pat dirs pid_cwd sess_epoch mem_iso
  mem_map=$(memory_last_written)

  for entry in "${AGENTS[@]}"; do
    IFS=':' read -r src name pat dirs <<<"$entry"
    pid_cwd="$(proc_cwd "$pat" | head -1)"
    sess_epoch=$(latest_session_mtime "$dirs")
    mem_iso=""
    while IFS='|' read -r mem_src mem_written; do
      [ "$mem_src" = "$src" ] && mem_iso="$mem_written"
    done <<<"$mem_map"
    if [ "$mode" = "json" ]; then
      # collect json
      :
    else
      print_row "$src" "$name" "$pid_cwd" "$sess_epoch" "$mem_iso"
    fi
  done

  if [ "$mode" = "json" ]; then
    # JSON mode: build directly
    printf '['
    local first=1
    for entry in "${AGENTS[@]}"; do
      IFS=':' read -r src name pat dirs <<<"$entry"
      pid_cwd="$(proc_cwd "$pat" | head -1)"
      sess_epoch=$(latest_session_mtime "$dirs")
      mem_iso=""
      while IFS='|' read -r mem_src mem_written; do
        [ "$mem_src" = "$src" ] && mem_iso="$mem_written"
      done <<<"$mem_map"
      local mem_epoch=$(iso_to_epoch "$mem_iso")
      local running=false cwd="—" status="—"
      [ -n "$pid_cwd" ] && running=true && cwd="${pid_cwd#*|}"
      if [ "$running" = true ]; then
        if is_num "$mem_epoch" && [ "$mem_epoch" -gt 0 ] && [ $(( NOW_EPOCH - mem_epoch )) -lt 3600 ]; then status="connected"; else status="running_no_memory"; fi
      fi
      local sess_age="null"
      is_num "$sess_epoch" && [ "$sess_epoch" -gt 0 ] && sess_age=$(( NOW_EPOCH - sess_epoch ))
      [ $first -eq 0 ] && printf ','
      first=0
      printf '{"source":"%s","name":"%s","running":%s,"cwd":"%s","sessionAgeSec":%s,"lastMemoryWrite":"%s","status":"%s"}' \
        "$src" "$name" "$running" "$cwd" "$sess_age" "$mem_iso" "$status"
    done
    printf ']\n'
  fi
}

case "${1:-}" in
  --json) main json ;;
  --watch)
    interval="${2:-5}"
    while true; do
      clear 2>/dev/null || true
      date '+%Y-%m-%d %H:%M:%S'
      main table
      sleep "$interval"
    done
    ;;
  *) main table ;;
esac

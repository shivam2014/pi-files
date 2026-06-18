#!/bin/bash
set -e

SESSION="pi-visual-test"
LOG_DIR="/tmp/pi-visual-test"
mkdir -p "$LOG_DIR"

# Kill any existing session
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Start tmux with PI_TUI_WRITE_LOG
export PI_TUI_WRITE_LOG="$LOG_DIR/tui-ansi.log"
tmux new-session -d -s "$SESSION" -x 120 -y 30

# Launch pi
tmux send-keys -t "$SESSION" "cd /Users/shivam94 && pi" Enter
sleep 4

# Capture initial state
tmux capture-pane -t "$SESSION" -p > "$LOG_DIR/01-initial.txt"
echo "=== Initial state captured ==="

# Send delegation command
tmux send-keys -t "$SESSION" "delegate scout to list files in the current directory" Enter
sleep 8

# Capture after delegation starts
tmux capture-pane -t "$SESSION" -p > "$LOG_DIR/02-delegation-start.txt"
echo "=== Delegation start captured ==="

# Wait for completion
sleep 15

# Capture after completion
tmux capture-pane -t "$SESSION" -p > "$LOG_DIR/03-delegation-complete.txt"
echo "=== Delegation complete captured ==="

# Send /debug command to dump render state
tmux send-keys -t "$SESSION" "/debug" Enter
sleep 2

# Capture debug state
tmux capture-pane -t "$SESSION" -p > "$LOG_DIR/04-debug.txt"
echo "=== Debug state captured ==="

# Copy pi-debug.log if it exists
if [ -f ~/.pi/agent/pi-debug.log ]; then
    cp ~/.pi/agent/pi-debug.log "$LOG_DIR/pi-debug.log"
    echo "=== pi-debug.log copied ==="
fi

# Copy ANSI log
if [ -f "$LOG_DIR/tui-ansi.log" ]; then
    echo "=== TUI ANSI log captured ==="
fi

# Show captured files
echo ""
echo "=== Captured files ==="
ls -la "$LOG_DIR/"

# Show the delegation screenshots
echo ""
echo "=== 02-delegation-start.txt ==="
cat "$LOG_DIR/02-delegation-start.txt"

echo ""
echo "=== 03-delegation-complete.txt ==="
cat "$LOG_DIR/03-delegation-complete.txt"

# Kill session
tmux kill-session -t "$SESSION" 2>/dev/null || true
echo ""
echo "=== Done ==="

# pi demo recorder — replays a real pi orchestrator session in a scratch project:
# the plan panel registers steps, a Scout delegation investigates the code, then a
# Coder edits src/validate.js to fix a failing test.
#
# KNOWN CAVEAT: with vhs 0.12.0 the encode step exits 0 under Chrome 132+ but
# never calls ffmpeg, so no output file is written. Harvest the PNG frames from
# $TMPDIR/vhs*/ and encode them with ffmpeg yourself; do not trust vhs' encode.
#
# VHS tape — records a REAL pi session in the scratch project.
# Syntax confirmed against vhs 0.12.0 via `vhs new` (Output/Set/Sleep/Type/Keys).
# NOTE: absolute Output paths MUST be quoted, otherwise the 0.12.0 parser splits on "/".
Output "/tmp/vhs-demo/pi-demo.gif"

Set Shell "bash"
Set FontSize 15
Set Width 1400
Set Height 900
Set Theme "Dracula"
Set Padding 20

# Enter the scratch project (genuinely failing test lives here).
Type "cd /tmp/vhs-demo/proj && clear"
Sleep 500ms
Enter
Sleep 2s

# Launch pi (TUI) with the task. Orchestrator extension renders the plan panel.
Type "pi 'fix the failing test in src/validate.js'"
Sleep 500ms
Enter

# Generous, realistic timing: pi startup + first model turn, then let the
# orchestrator register the plan and run the scout/coder specialists.
Sleep 10s
Sleep 25s
Sleep 25s
Sleep 25s

# End cleanly so the tape can never hang forever.
Ctrl+C
Sleep 1s

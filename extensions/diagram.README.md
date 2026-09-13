# diagram

One snippet of matplotlib becomes an image.

## What it solves

Drawing a plot or diagram usually means running a script and wiring the image back in. diagram exposes a single tool that takes matplotlib code and returns the rendered image.

## Tools

- `draw_diagram` — generate a diagram or plot from matplotlib Python code. The code must create a figure with `plt`.

Parameters:

| Param | Required | Description |
|-------|----------|-------------|
| `code` | yes | Matplotlib code that builds a figure with `plt` |
| `output` | no | File path to also save the image to (e.g. `/tmp/diagram.png`) |
| `width` | no | Image width in pixels (default 800) |
| `height` | no | Image height in pixels (default 600) |
| `dpi` | no | Output DPI (default 100) |

## Notes

- Runs the code through `python3` and the `draw_diagram.py` helper (`~/.pi/scripts/draw_diagram.py`).
- Returns the image inline as a tool result, and saves it when `output` is given.

## Usage

```
draw_diagram(code="import matplotlib.pyplot as plt; plt.plot([1,2,3]); plt.title('My Plot')")
```

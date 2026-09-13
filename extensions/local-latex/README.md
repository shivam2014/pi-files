# local-latex

Compiles `.tex` to PDF locally. No cloud.

## What it solves

Compiling LaTeX usually means deciding between TeX Live and Tectonic and knowing which packages are installed. local-latex detects both engines, picks a working one, and reports what it found.

## Tools

| Tool | Purpose | Parameters |
|------|---------|------------|
| `latex-doctor` | Check installed engines and run a smoke test | `json?` |
| `latex-compile` | Compile `.tex` to PDF | `tex_file`, `compiler?`, `engine?`, `output_directory?` |
| `latex-tectonic-suitability` | Check whether a project works with Tectonic | `tex_file` |

## Compiler selection (`compiler`)

- **auto** (default): TeX Live → Tectonic (if suitable) → TeX Live retry.
- **tectonic**: force Tectonic (self-contained, no bibtex).
- **texlive**: force TeX Live (latexmk or direct engine).

## Engine selection (`engine`)

- **pdflatex** (default): standard, no OpenType fonts.
- **xelatex**: OpenType fonts, system fonts.
- **lualatex**: OpenType fonts, Lua scripting.

## Notes

- `pdflatex` runs two passes automatically for cross-references.
- Missing packages auto-install through TinyTeX's `tlmgr` when using TeX Live.
- Documents with a bibliography should force the `texlive` compiler — Tectonic does not support bibtex natively.
- Run `latex-doctor` first if you are unsure the engines are set up.

## Usage

```
latex-doctor
latex-compile path/to/file.tex
```

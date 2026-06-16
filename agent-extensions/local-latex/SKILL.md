# local-latex

Compile LaTeX documents using local TeX Live installation.

## Tools

| Tool | Purpose | Parameters |
|------|---------|------------|
| `latex-doctor` | Check installed engines, run smoke test | (none) |
| `latex-compile` | Compile .tex → PDF | tex_file, compiler?, engine?, output_directory? |
| `latex-tectonic-suitability` | Check project compatibility with Tectonic | tex_file |

## Workflow

1. **Verify setup**: `latex-doctor` to check what's available
2. **Check compatibility**: `latex-tectonic-suitability file.tex` for complex projects
3. **Compile**: `latex-compile path/to/file.tex`

## Compiler Selection (compiler param)

- **auto** (default): TeX Live → Tectonic (if suitable) → TeX Live retry
- **tectonic**: Force Tectonic (fast, self-contained, no bibtex)
- **texlive**: Force TeX Live (latexmk or direct pdflatex)

## Engine Selection (engine param)

- **pdflatex** (default): Standard, no OpenType font support
- **xelatex**: OpenType font support, system fonts
- **lualatex**: OpenType, Lua scripting capabilities

## Notes

- pdflatex runs two passes automatically for cross-references
- Missing packages auto-installed via TinyTeX's tlmgr
- TeX Live installation: `/Users/shivam94/Documents/Resume/texlive/`
- Tectonic binary: bundled at `~/.codex/.tmp/.../plugins/latex/bin/tectonic`

## Tips

- After editing .tex files, run `latex-compile` to verify syntax
- Use `latex-doctor` if compilation fails unexpectedly to check installation health
- For documents with bibliography, force `texlive` compiler (Tectonic doesn't support bibtex natively)

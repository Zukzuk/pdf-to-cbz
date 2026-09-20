# pdf-to-cbz

Converts every PDF in a folder into a `.cbz` comic archive of JPEG pages.

## Run

Copy `.env.example` to `.env` (gitignored) and set your folders:

- `PDF_IN` - folder with the PDFs (mounted read-only)
- `CBZ_OUT` - folder the `.cbz` files are written to (can be the same as `PDF_IN`)
- `HOST_TMP` - scratch folder for GraphicsMagick temp files (mounted as `/tmp`)

Then:

```
docker compose run --rm converter
```

Values in your shell override `.env` for a single run (PowerShell):

```
$env:PDF_IN = "D:\comics\pdf"; docker compose run --rm converter
```

Rebuild after changing the code: `docker compose build`.

Without compose:

```
docker build -t pdf-converter .
docker run --rm -v "<HOST_TMP>:/tmp" -v "<PDF_IN>:/inPdfs" -v "<CBZ_OUT>:/outCbz" pdf-converter node dist/convertFolderOfPdfs.js /inPdfs /outCbz
```

## What it does

For each PDF, pages are rendered to JPEG in a subfolder named after the PDF, zipped into `<name>.cbz`,
and the subfolder is removed.

- **Aspect ratio is preserved.** Pages are scaled proportionally so both sides are at least 1200x1600, never
  stretched. Every output image is checked against its source page; if the ratio is off by more than 0.5%
  the PDF fails and no CBZ is written.
- **Live progress.** Each page is logged as it finishes (`Page 5/6 done ...`). Four pages run at once, so they
  can finish out of order; the `done/total` counter is the reliable progress number.

The sizing, quality and concurrency settings are constants at the top of `convertFolderOfPdfs.ts`.

## Development

TypeScript, compiled with `tsc` to `dist/` (the Dockerfile does this during the image build).

```
npm install
npm run build
```
